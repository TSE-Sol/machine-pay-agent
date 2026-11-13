// Guardrails: the safety limits on what the agent may pay.
//
// These are plain code checks that run on the charger's actual 402 payment request,
// after the planner has chosen and before anything is signed. The planner (LLM or
// rules) only proposes; nothing it returns can skip or loosen a check here.
//
// Each check returns { name, ok, reason }. A payment goes ahead only if every check is ok.
import { formatUsdc } from "./config.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pass = (name) => ({ name, ok: true, reason: null });
const fail = (name, reason) => ({ name, ok: false, reason });

/** The 402 amount as a BigInt of base units, or null if it isn't a plain positive integer. */
export function parseAmount(value) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > 0n ? amount : null;
}

/** Total paid (base units) in the 24 hours before `now`. */
export function spentLast24h(payments, now) {
  return payments.filter((p) => p.time > now - DAY_MS).reduce((sum, p) => sum + p.amount, 0n);
}

/** Kill switch: AGENT_PAUSED=true (or the agent/PAUSED file) stops all payments. */
export function checkKillSwitch(limits) {
  return limits.paused ? fail("kill-switch", "agent is paused (AGENT_PAUSED=true); all payments are stopped") : pass("kill-switch");
}

/** Allowlist: pay only known recipients, on known networks, in known tokens. */
export function checkAllowlist(quote, limits) {
  if (quote.scheme !== "exact") return fail("allowlist", `payment scheme "${quote.scheme}" is not allowed (only "exact")`);
  if (!limits.allowedNetworks.includes(quote.network)) return fail("allowlist", `network ${quote.network} is not on the allowlist`);
  if (!limits.allowedAssets.includes(quote.asset)) return fail("allowlist", `token ${quote.asset} is not on the allowlist`);
  if (!limits.allowedPayTo.includes(quote.payTo)) return fail("allowlist", `recipient ${quote.payTo} is not on the allowlist`);
  return pass("allowlist");
}

/** Price sanity: the 402 must ask for exactly the price advertised on /devices. */
export function checkPrice(amount, expectedAmount) {
  if (amount === null) return fail("price", "the 402 amount is not a valid positive integer");
  if (amount !== expectedAmount) {
    return fail("price", `402 asks for ${formatUsdc(amount)} USDC but the advertised price is ${formatUsdc(expectedAmount)} USDC`);
  }
  return pass("price");
}

/** Per-payment cap (MAX_PER_TX_USDC). */
export function checkPerTx(amount, limits) {
  if (amount === null) return fail("per-tx", "amount unknown");
  if (amount > limits.maxPerTx) {
    return fail("per-tx", `${formatUsdc(amount)} USDC is over the ${formatUsdc(limits.maxPerTx)} USDC per-payment limit (MAX_PER_TX_USDC)`);
  }
  return pass("per-tx");
}

/** Daily budget (DAILY_BUDGET_USDC) over a rolling 24 hours, from the audit log. */
export function checkDailyBudget(amount, payments, limits, now) {
  if (amount === null) return fail("daily", "amount unknown");
  const spent = spentLast24h(payments, now);
  if (spent + amount > limits.dailyBudget) {
    return fail(
      "daily",
      `${formatUsdc(amount)} USDC would bring 24h spending to ${formatUsdc(spent + amount)} USDC, over the ${formatUsdc(limits.dailyBudget)} USDC budget (DAILY_BUDGET_USDC)`,
    );
  }
  return pass("daily");
}

/** Rate limit (MAX_PAYMENTS_PER_10_MIN). */
export function checkRateLimit(payments, limits, now) {
  const recent = payments.filter((p) => p.time > now - TEN_MINUTES_MS).length;
  if (recent >= limits.maxPaymentsPer10Min) {
    return fail("rate-limit", `already made ${recent} payments in the last 10 minutes (limit ${limits.maxPaymentsPer10Min}, MAX_PAYMENTS_PER_10_MIN)`);
  }
  return pass("rate-limit");
}

/** Human approval is needed for any single payment above APPROVAL_THRESHOLD_USDC. */
export function needsApproval(amount, limits) {
  return amount !== null && amount > limits.approvalThreshold;
}

/**
 * Run every guardrail against one payment request.
 *   quote          - the 402's payment requirement: { scheme, network, asset, payTo, amount }
 *   expectedAmount - advertised price for the planned session, in base units (BigInt)
 *   limits         - config.limits
 *   payments       - payment history from the audit log: [{ time, amount }]
 * Returns { allowed, checks, reasons, needsApproval, amount }.
 */
export function evaluatePayment({ quote, expectedAmount, limits, payments, now = Date.now() }) {
  const amount = parseAmount(quote.amount);
  const checks = [
    checkKillSwitch(limits),
    checkAllowlist(quote, limits),
    checkPrice(amount, expectedAmount),
    checkPerTx(amount, limits),
    checkDailyBudget(amount, payments, limits, now),
    checkRateLimit(payments, limits, now),
  ];
  const reasons = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.reason}`);
  return {
    allowed: reasons.length === 0,
    checks,
    reasons,
    needsApproval: needsApproval(amount, limits),
    amount,
  };
}

/**
 * Final gate: guardrails must all pass, and if the payment is above the approval
 * threshold a human must say yes. `askHuman` returns true only on an explicit yes.
 * Returns { approved, reasons, approval } where approval is "not-needed" | "granted" | "denied".
 */
export async function authorizePayment(evaluation, askHuman) {
  if (!evaluation.allowed) return { approved: false, reasons: evaluation.reasons, approval: "not-asked" };
  if (!evaluation.needsApproval) return { approved: true, reasons: [], approval: "not-needed" };

  const yes = (await askHuman()) === true;
  return yes
    ? { approved: true, reasons: [], approval: "granted" }
    : { approved: false, reasons: ["approval: a human did not approve this payment (above APPROVAL_THRESHOLD_USDC)"], approval: "denied" };
}
