// The agent's decision loop. One call to runCycle() is one pass through the phases:
//
//   OBSERVE -> DECIDE -> DISCOVER -> PLAN -> GUARD -> PAY -> VERIFY -> RECORD
//
// Every phase prints one console line, is sent to the dashboard with its details, and
// (once a charge is needed) is written to the audit log.
// The pass stops early if no charge is needed, a guardrail refuses, or a step fails.
import { randomUUID } from "node:crypto";
import { formatUsdc, toBaseUnits } from "./config.js";
import { authorizePayment, evaluatePayment, spentLast24h } from "./guardrails.js";
import { makePlan } from "./planner.js";
import { distanceKm } from "./robot.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (isoTime) => new Date(isoTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shorten = (text) => (text.length > 12 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text);
export const explorerUrl = (txSignature) => `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;

/**
 * deps: { robot, config, limits, getLimits?, charger, wallet, audit, askHuman, log, llm? }
 *   limits  - config.limits with `paused` already resolved for this cycle
 *   getLimits - optional; returns the limits as they are right now (used to re-check after a wait)
 *   log     - (phase, message, data) => void; data is the structured detail for the dashboard
 *   askHuman - (question, request) => true/false or { approved, by }
 * Returns { outcome, ... } where outcome is one of:
 *   "no_charge_needed" | "charging" | "refused" | "failed"
 */
export async function runCycle({ robot, config, limits, getLimits, charger, wallet, audit, askHuman, log: output, llm }) {
  const cycleId = randomUUID().slice(0, 8);
  const log = (phase, message, data = {}) => output(phase, message, { cycleId, ...data });
  const record = (phase, data = {}) => audit.write({ robotId: robot.id, cycleId, phase, ...data });
  const finish = (outcome, data = {}) => {
    record("RECORD", { outcome, ...data });
    return { outcome, cycleId, ...data };
  };

  // OBSERVE: battery, location, budget remaining
  const now = Date.now();
  robot.tick(now);
  const state = robot.snapshot();
  const payments = audit.payments();
  const spent = spentLast24h(payments, now);
  const budgetLeft = limits.dailyBudget > spent ? limits.dailyBudget - spent : 0n;
  log("OBSERVE", `battery ${state.batteryPct}% | budget left ${formatUsdc(budgetLeft)} USDC`, { batteryPct: state.batteryPct });

  // DECIDE: is a charge needed?
  if (robot.batteryPct >= config.lowBatteryPct) {
    log("DECIDE", `battery at or above ${config.lowBatteryPct}% → keep delivering`, { chargeNeeded: false });
    return { outcome: "no_charge_needed", cycleId };
  }
  robot.seekCharge();
  log("DECIDE", `battery below ${config.lowBatteryPct}% → seeking charge`, { chargeNeeded: true });
  record("OBSERVE", { batteryPct: state.batteryPct, location: state.location, budgetLeft: budgetLeft.toString() });
  record("DECIDE", { chargeNeeded: true, lowBatteryPct: config.lowBatteryPct });

  // Kill switch, checked before doing any work. (GUARD checks it again.)
  if (limits.paused) {
    const reason = "kill-switch: agent is paused (AGENT_PAUSED=true); all payments are stopped";
    log("GUARD", "✗ kill-switch", { checks: [{ name: "kill-switch", ok: false, reason }], approval: "not-asked", approved: false });
    log("REFUSED", reason, { reasons: [reason] });
    return finish("refused", { reasons: [reason] });
  }

  // DISCOVER: what chargers exist?
  let devices;
  try {
    devices = await charger.listDevices();
  } catch (error) {
    log("DISCOVER", `charger server unreachable (${error.message})`, { failed: true });
    return finish("failed", { reasons: ["charger server unreachable"] });
  }
  const chargers = devices.map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    distanceKm: Number(distanceKm(state.location, d.location).toFixed(2)),
    priceUsdc: { 15: d.pricePer15MinUSDC, 30: d.pricePer15MinUSDC * 2, 60: d.pricePer15MinUSDC * 4 },
  }));
  const idleCount = chargers.filter((c) => c.status === "idle").length;
  log("DISCOVER", `${chargers.length} chargers, ${idleCount} idle`, { chargers });
  record("DISCOVER", { chargers });
  if (idleCount === 0) return finish("failed", { reasons: ["no idle chargers"] });

  // PLAN: choose a charger and session length (LLM, or rules if no key / on failure)
  const plan = await makePlan(
    {
      robot: state,
      chargers,
      budgetLeftUsdc: Number(formatUsdc(budgetLeft)),
      targetBatteryPct: config.targetBatteryPct,
      chargePctPerMinute: robot.chargePctPerMinute,
    },
    { apiKey: config.planner.apiKey, model: config.planner.model, llm },
  );
  if (plan.note) log("PLAN", `using the rule-based planner (${plan.note})`, { note: plan.note });
  log("PLAN", `(${plan.planner}) ${plan.deviceId}, ${plan.minutes} min — "${plan.reason}"`, {
    planner: plan.planner,
    model: plan.planner === "claude" ? config.planner.model : null,
    deviceId: plan.deviceId,
    minutes: plan.minutes,
    reason: plan.reason,
  });
  record("PLAN", plan);

  // GUARD: get the charger's real 402 payment request and run every guardrail on it
  const device = devices.find((d) => d.id === plan.deviceId);
  const expectedAmount = toBaseUnits(device.pricePer15MinUSDC) * BigInt(plan.minutes / 15);
  const quoted = await charger.requestQuote(plan.deviceId, plan.minutes).catch((error) => ({ ok: false, detail: error.message }));
  const quote = quoted.ok ? quoted.paymentRequired.accepts?.[0] : null;
  if (!quote) {
    const reason = `no usable 402 from ${plan.deviceId} (${quoted.detail ?? "empty accepts list"})`;
    log("GUARD", reason, { failed: true });
    return finish("failed", { reasons: [reason] });
  }

  const evaluation = evaluatePayment({ quote, expectedAmount, limits, payments, now });
  let answeredBy = null; // who answered the approval question: terminal, dashboard or timeout
  const decision = await authorizePayment(evaluation, async () => {
    log("GUARD", `waiting for human approval of ${formatUsdc(evaluation.amount)} USDC`, { awaitingApproval: true });
    const answer = await askHuman(`[GUARD] Approve ${formatUsdc(evaluation.amount)} USDC for ${plan.minutes} min at ${plan.deviceId}?`, {
      deviceId: plan.deviceId,
      minutes: plan.minutes,
      amount: quote.amount,
      payTo: quote.payTo,
    });
    answeredBy = answer?.by ?? null;
    return answer === true || answer?.approved === true;
  });
  const via = answeredBy ? ` (${answeredBy})` : "";
  const approvalMark = {
    "not-needed": "✓ approval-not-needed",
    granted: `✓ approval-granted${via}`,
    denied: `✗ approval-denied${via}`,
    "not-asked": "– approval-not-asked",
  };
  const marks = evaluation.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}`);
  log("GUARD", [...marks, approvalMark[decision.approval]].join(" "), {
    checks: evaluation.checks,
    approval: decision.approval,
    approvalBy: answeredBy,
    approved: decision.approved,
    amount: quote.amount,
    deviceId: plan.deviceId,
    minutes: plan.minutes,
  });
  record("GUARD", {
    quote: { scheme: quote.scheme, network: quote.network, asset: quote.asset, payTo: quote.payTo, amount: quote.amount },
    expectedAmount: expectedAmount.toString(),
    checks: evaluation.checks,
    approval: decision.approval,
    approvalBy: answeredBy,
    approved: decision.approved,
  });
  if (!decision.approved) {
    for (const reason of decision.reasons) log("REFUSED", reason, { reasons: decision.reasons });
    return finish("refused", { reasons: decision.reasons });
  }

  // A human may take a minute to answer, and a 402 goes stale in about that time (it carries
  // a recent blockhash for the transaction). So after an approval, ask the charger for a fresh
  // 402 and sign that one, but only if its terms are exactly the ones that were just checked
  // and approved, and every guardrail still passes right now.
  let signable = { paymentRequired: quoted.paymentRequired, requirement: quote };
  if (decision.approval === "granted") {
    const requoted = await charger.requestQuote(plan.deviceId, plan.minutes).catch((error) => ({ ok: false, detail: error.message }));
    const fresh = requoted.ok ? requoted.paymentRequired.accepts?.[0] : null;
    const sameTerms = Boolean(fresh) && ["scheme", "network", "asset", "payTo", "amount"].every((field) => fresh[field] === quote[field]);
    const recheck = sameTerms
      ? evaluatePayment({ quote: fresh, expectedAmount, limits: getLimits ? getLimits() : limits, payments: audit.payments(), now: Date.now() })
      : null;
    if (!recheck?.allowed) {
      const reasons = !fresh
        ? [`requote: no usable 402 from ${plan.deviceId} after approval (${requoted.detail ?? "empty accepts list"})`]
        : !sameTerms
          ? ["requote: the charger changed its payment terms after the approval"]
          : recheck.reasons;
      for (const reason of reasons) log("REFUSED", reason, { reasons });
      record("GUARD", { requote: true, approved: false, reasons });
      return finish("refused", { reasons });
    }
    signable = { paymentRequired: requoted.paymentRequired, requirement: fresh };
  }

  // PAY: sign the approved request and retry with PAYMENT-SIGNATURE
  const paymentId = randomUUID();
  const payment = { paymentId, deviceId: plan.deviceId, amount: quote.amount, payTo: quote.payTo };
  record("PAY", { ...payment, status: "pending" });

  let paymentHeaders;
  try {
    paymentHeaders = await wallet.signPayment(signable.paymentRequired, signable.requirement);
  } catch (error) {
    record("PAY", { ...payment, status: "failed", error: error.message }); // nothing was sent
    log("PAY", `could not sign the payment: ${error.message}`, { failed: true });
    return finish("failed", { reasons: [`signing failed: ${error.message}`] });
  }

  let result;
  try {
    result = await charger.submitPayment(plan.deviceId, plan.minutes, paymentHeaders);
  } catch (error) {
    // The request may or may not have reached the server. The payment stays "pending",
    // which still counts against the budget.
    log("PAY", `no response from the charger (${error.message}); payment state unknown`, { failed: true });
    return finish("failed", { reasons: ["no response after sending payment"] });
  }

  // VERIFY (part 1): HTTP 200 and a successful PAYMENT-RESPONSE receipt
  const txSignature = result.receipt?.success === true ? result.receipt.transaction : null;
  if (result.status !== 200 || !txSignature) {
    const why = result.body?.error ?? result.receipt?.errorReason ?? "no successful PAYMENT-RESPONSE";
    // 4xx means the server did not take the payment. On 5xx we can't be sure, so it stays pending.
    if (result.status >= 400 && result.status < 500) record("PAY", { ...payment, status: "failed", error: why });
    log("PAY", `payment not accepted (HTTP ${result.status}: ${why})`, { failed: true });
    return finish("failed", { reasons: [`payment not accepted: ${why}`] });
  }
  record("PAY", { ...payment, status: "settled", txSignature });
  const paid = { amount: quote.amount, deviceId: plan.deviceId, minutes: plan.minutes, txSignature, explorerUrl: explorerUrl(txSignature) };
  log("PAY", `${formatUsdc(quote.amount)} USDC → sig ${shorten(txSignature)}`, paid);
  log("PAY", explorerUrl(txSignature), { link: true });

  // VERIFY (part 2): poll the charger until it reports "charging"
  let status = null;
  for (let attempt = 0; attempt < 10 && status?.status !== "charging"; attempt++) {
    if (attempt > 0) await sleep(500);
    status = await charger.getStatus(plan.deviceId).catch(() => null);
  }
  if (status?.status !== "charging") {
    log("VERIFY", `✗ paid, but ${plan.deviceId} is not charging`, { deviceId: plan.deviceId, charging: false, failed: true });
    record("VERIFY", { deviceId: plan.deviceId, charging: false, txSignature });
    return finish("failed", { reasons: ["paid but charger did not turn on"], txSignature });
  }
  log("VERIFY", `${plan.deviceId} charging until ${clock(status.expiresAt)}`, { deviceId: plan.deviceId, charging: true, expiresAt: status.expiresAt });
  record("VERIFY", { deviceId: plan.deviceId, charging: true, sessionId: status.sessionId, expiresAt: status.expiresAt });

  robot.startCharging({ deviceId: plan.deviceId, location: device.location, minutes: plan.minutes, expiresAt: status.expiresAt });

  // RECORD: the cycle's outcome
  const spentNow = spent + evaluation.amount;
  log("RECORD", `paid ${formatUsdc(evaluation.amount)} USDC | 24h spend ${formatUsdc(spentNow)} of ${formatUsdc(limits.dailyBudget)} USDC | audit log updated`, {
    outcome: "charging",
    amount: quote.amount,
    txSignature,
  });
  return finish("charging", {
    deviceId: plan.deviceId,
    minutes: plan.minutes,
    amount: quote.amount,
    txSignature,
    explorerUrl: explorerUrl(txSignature),
    planner: plan.planner,
  });
}
