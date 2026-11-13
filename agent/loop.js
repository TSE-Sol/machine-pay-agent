// The agent's decision loop. One call to runCycle() is one pass through the phases:
//
//   OBSERVE -> DECIDE -> DISCOVER -> PLAN -> GUARD -> PAY -> VERIFY -> RECORD
//
// Every phase prints one console line and (once a charge is needed) one audit-log entry.
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
 * deps: { robot, config, limits, charger, wallet, audit, askHuman, log, llm? }
 *   limits  - config.limits with `paused` already resolved for this cycle
 *   log     - (phase, message) => void
 * Returns { outcome, ... } where outcome is one of:
 *   "no_charge_needed" | "charging" | "refused" | "failed"
 */
export async function runCycle({ robot, config, limits, charger, wallet, audit, askHuman, log, llm }) {
  const cycleId = randomUUID().slice(0, 8);
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
  log("OBSERVE", `battery ${state.batteryPct}% | budget left ${formatUsdc(budgetLeft)} USDC`);

  // DECIDE: is a charge needed?
  if (robot.batteryPct >= config.lowBatteryPct) {
    log("DECIDE", `battery at or above ${config.lowBatteryPct}% → keep delivering`);
    return { outcome: "no_charge_needed", cycleId };
  }
  robot.seekCharge();
  log("DECIDE", `battery below ${config.lowBatteryPct}% → seeking charge`);
  record("OBSERVE", { batteryPct: state.batteryPct, location: state.location, budgetLeft: budgetLeft.toString() });
  record("DECIDE", { chargeNeeded: true, lowBatteryPct: config.lowBatteryPct });

  // Kill switch, checked before doing any work. (GUARD checks it again.)
  if (limits.paused) {
    const reason = "kill-switch: agent is paused (AGENT_PAUSED=true); all payments are stopped";
    log("GUARD", "✗ kill-switch");
    log("GUARD", `REFUSED — ${reason}`);
    return finish("refused", { reasons: [reason] });
  }

  // DISCOVER: what chargers exist?
  let devices;
  try {
    devices = await charger.listDevices();
  } catch (error) {
    log("DISCOVER", `charger server unreachable (${error.message})`);
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
  log("DISCOVER", `${chargers.length} chargers, ${idleCount} idle`);
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
  if (plan.note) log("PLAN", `using the rule-based planner (${plan.note})`);
  log("PLAN", `(${plan.planner}) ${plan.deviceId}, ${plan.minutes} min — "${plan.reason}"`);
  record("PLAN", plan);

  // GUARD: get the charger's real 402 payment request and run every guardrail on it
  const device = devices.find((d) => d.id === plan.deviceId);
  const expectedAmount = toBaseUnits(device.pricePer15MinUSDC) * BigInt(plan.minutes / 15);
  const quoted = await charger.requestQuote(plan.deviceId, plan.minutes).catch((error) => ({ ok: false, detail: error.message }));
  const quote = quoted.ok ? quoted.paymentRequired.accepts?.[0] : null;
  if (!quote) {
    const reason = `no usable 402 from ${plan.deviceId} (${quoted.detail ?? "empty accepts list"})`;
    log("GUARD", reason);
    return finish("failed", { reasons: [reason] });
  }

  const evaluation = evaluatePayment({ quote, expectedAmount, limits, payments, now });
  const decision = await authorizePayment(evaluation, () =>
    askHuman(`[GUARD] Approve ${formatUsdc(evaluation.amount)} USDC for ${plan.minutes} min at ${plan.deviceId}?`),
  );
  const approvalMark = { "not-needed": "✓ approval-not-needed", granted: "✓ approval-granted", denied: "✗ approval-denied", "not-asked": "– approval-not-asked" };
  const marks = evaluation.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}`);
  log("GUARD", [...marks, approvalMark[decision.approval]].join(" "));
  record("GUARD", {
    quote: { scheme: quote.scheme, network: quote.network, asset: quote.asset, payTo: quote.payTo, amount: quote.amount },
    expectedAmount: expectedAmount.toString(),
    checks: evaluation.checks,
    approval: decision.approval,
    approved: decision.approved,
  });
  if (!decision.approved) {
    for (const reason of decision.reasons) log("GUARD", `REFUSED — ${reason}`);
    return finish("refused", { reasons: decision.reasons });
  }

  // PAY: sign the approved request and retry with PAYMENT-SIGNATURE
  const paymentId = randomUUID();
  const payment = { paymentId, deviceId: plan.deviceId, amount: quote.amount, payTo: quote.payTo };
  record("PAY", { ...payment, status: "pending" });

  let paymentHeaders;
  try {
    paymentHeaders = await wallet.signPayment(quoted.paymentRequired, quote);
  } catch (error) {
    record("PAY", { ...payment, status: "failed", error: error.message }); // nothing was sent
    log("PAY", `could not sign the payment: ${error.message}`);
    return finish("failed", { reasons: [`signing failed: ${error.message}`] });
  }

  let result;
  try {
    result = await charger.submitPayment(plan.deviceId, plan.minutes, paymentHeaders);
  } catch (error) {
    // The request may or may not have reached the server. The payment stays "pending",
    // which still counts against the budget.
    log("PAY", `no response from the charger (${error.message}); payment state unknown`);
    return finish("failed", { reasons: ["no response after sending payment"] });
  }

  // VERIFY (part 1): HTTP 200 and a successful PAYMENT-RESPONSE receipt
  const txSignature = result.receipt?.success === true ? result.receipt.transaction : null;
  if (result.status !== 200 || !txSignature) {
    const why = result.body?.error ?? result.receipt?.errorReason ?? "no successful PAYMENT-RESPONSE";
    // 4xx means the server did not take the payment. On 5xx we can't be sure, so it stays pending.
    if (result.status >= 400 && result.status < 500) record("PAY", { ...payment, status: "failed", error: why });
    log("PAY", `payment not accepted (HTTP ${result.status}: ${why})`);
    return finish("failed", { reasons: [`payment not accepted: ${why}`] });
  }
  record("PAY", { ...payment, status: "settled", txSignature });
  log("PAY", `${formatUsdc(quote.amount)} USDC → sig ${shorten(txSignature)}`);
  log("PAY", explorerUrl(txSignature));

  // VERIFY (part 2): poll the charger until it reports "charging"
  let status = null;
  for (let attempt = 0; attempt < 10 && status?.status !== "charging"; attempt++) {
    if (attempt > 0) await sleep(500);
    status = await charger.getStatus(plan.deviceId).catch(() => null);
  }
  if (status?.status !== "charging") {
    log("VERIFY", `✗ paid, but ${plan.deviceId} is not charging`);
    record("VERIFY", { deviceId: plan.deviceId, charging: false, txSignature });
    return finish("failed", { reasons: ["paid but charger did not turn on"], txSignature });
  }
  log("VERIFY", `${plan.deviceId} charging until ${clock(status.expiresAt)}`);
  record("VERIFY", { deviceId: plan.deviceId, charging: true, sessionId: status.sessionId, expiresAt: status.expiresAt });

  robot.startCharging({ deviceId: plan.deviceId, location: device.location, minutes: plan.minutes, expiresAt: status.expiresAt });

  // RECORD: the cycle's outcome
  const spentNow = spent + evaluation.amount;
  log("RECORD", `paid ${formatUsdc(evaluation.amount)} USDC | 24h spend ${formatUsdc(spentNow)} of ${formatUsdc(limits.dailyBudget)} USDC | audit log updated`);
  return finish("charging", {
    deviceId: plan.deviceId,
    minutes: plan.minutes,
    amount: quote.amount,
    txSignature,
    explorerUrl: explorerUrl(txSignature),
    planner: plan.planner,
  });
}
