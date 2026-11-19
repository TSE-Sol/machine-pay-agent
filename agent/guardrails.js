// Guardrails: the safety limits on what the agent may pay.
//
// These are plain code checks that run on the charger's actual 402 payment request,
// after the planner has chosen and before anything is signed. The planner (LLM or
// rules) only proposes; nothing it returns can skip or loosen a check here.
//
// Each check returns { name, ok, reason }. A payment goes ahead only if every check is ok,
// with one narrow exception for emergencies, described next.
//
// The checks come in two groups:
//   HARD  kill-switch, allowlist, price, per-tx. Nobody can override these, ever.
//   SOFT  rate-limit, daily. These pace spending. When the battery is critically low and a
//         soft limit is the ONLY thing in the way, the agent may ask a human to allow this
//         one payment. An approval covers that single payment; no limit is raised or reset.
import { formatUsdc } from "./config.js";

export const HARD_GUARDRAILS = Object.freeze(["kill-switch", "allowlist", "price", "per-tx"]);
export const SOFT_GUARDRAILS = Object.freeze(["rate-limit", "daily"]);

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

/**
 * When the 24-hour spend next goes down: the moment the oldest counted payment turns
 * 24 hours old. Returns a timestamp in ms, or null if nothing has been spent.
 */
export function budgetNextResetAt(payments, now) {
  const counted = payments.filter((p) => p.time > now - DAY_MS).map((p) => p.time);
  return counted.length === 0 ? null : Math.min(...counted) + DAY_MS;
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

/**
 * Rate limit (MAX_PAYMENTS_PER_10_MIN). The ten minutes are simulated minutes: in demo time
 * (DEMO_SECONDS_PER_MINUTE below 60) the window shrinks by the same factor as a charging
 * session, so a sped-up demo does not hit the limit early. limits.rateLimitWindowMs carries
 * the scaled window; without it the window is ten real minutes.
 */
export function checkRateLimit(payments, limits, now) {
  const windowMs = limits.rateLimitWindowMs ?? TEN_MINUTES_MS;
  const recent = payments.filter((p) => p.time > now - windowMs).length;
  if (recent >= limits.maxPaymentsPer10Min) {
    const scaled = windowMs === TEN_MINUTES_MS ? "" : ` of demo time (${Math.round(windowMs / 1000)} s)`;
    return fail("rate-limit", `already made ${recent} payments in the last 10 minutes${scaled} (limit ${limits.maxPaymentsPer10Min}, MAX_PAYMENTS_PER_10_MIN)`);
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
 * Returns { allowed, checks, reasons, needsApproval, amount, hardFailures, softFailures }.
 * hardFailures and softFailures are the names of the failed checks in each group.
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
  const failed = checks.filter((check) => !check.ok);
  const reasons = failed.map((check) => `${check.name}: ${check.reason}`);
  return {
    allowed: reasons.length === 0,
    checks,
    reasons,
    needsApproval: needsApproval(amount, limits),
    amount,
    // Anything not explicitly listed as soft counts as hard.
    hardFailures: failed.filter((check) => !SOFT_GUARDRAILS.includes(check.name)).map((check) => check.name),
    softFailures: failed.filter((check) => SOFT_GUARDRAILS.includes(check.name)).map((check) => check.name),
  };
}

/**
 * May the agent ask a human for an emergency override of this payment?
 * Only when all three hold: no hard check failed, at least one soft check failed, and the
 * battery is at or below the critical level. Returns the soft limits that would be overridden,
 * or null when escalation is not allowed.
 */
export function emergencyOverrideFor(evaluation, { batteryPct, criticalBatteryPct }) {
  if (evaluation.hardFailures.length > 0) return null; // a hard limit is never up for discussion
  if (evaluation.softFailures.length === 0) return null; // nothing to override
  if (!(batteryPct <= criticalBatteryPct)) return null; // not an emergency: refuse and retry as usual
  return [...evaluation.softFailures];
}

/**
 * Did everything pass, apart from soft limits a human has just agreed to override?
 * Used to re-check a payment after an emergency approval: a hard failure, or a soft failure
 * that was not part of the approval, still stops it.
 */
export function passesWithOverride(evaluation, overridden = []) {
  return evaluation.hardFailures.length === 0 && evaluation.softFailures.every((name) => overridden.includes(name));
}

/**
 * Final gate: guardrails must all pass, and if the payment is above the approval
 * threshold a human must say yes. `askHuman` returns true only on an explicit yes.
 *
 * `emergency` is the list of soft limits from emergencyOverrideFor(), or null. When it is
 * given, the failed soft limits do not refuse the payment outright: a human is asked whether
 * to let this one payment through. Hard failures are refused before anyone is asked.
 *
 * Returns { approved, reasons, approval, overridden } where approval is
 * "not-needed" | "granted" | "denied" | "not-asked", and overridden lists the soft limits a
 * human overrode for this payment (empty unless an emergency override was granted).
 */
export async function authorizePayment(evaluation, askHuman, { emergency = null } = {}) {
  if (!evaluation.allowed) {
    const mayAsk = emergency && emergency.length > 0 && passesWithOverride(evaluation, emergency);
    if (!mayAsk) return { approved: false, reasons: evaluation.reasons, approval: "not-asked", overridden: [] };

    const yes = (await askHuman({ emergency: true, limits: emergency })) === true;
    return yes
      ? { approved: true, reasons: [], approval: "granted", overridden: [...emergency] }
      : {
          approved: false,
          reasons: [...evaluation.reasons, `approval: a human did not approve the emergency override of ${emergency.join(" and ")}`],
          approval: "denied",
          overridden: [],
        };
  }
  if (!evaluation.needsApproval) return { approved: true, reasons: [], approval: "not-needed", overridden: [] };

  const yes = (await askHuman({ emergency: false, limits: [] })) === true;
  return yes
    ? { approved: true, reasons: [], approval: "granted", overridden: [] }
    : { approved: false, reasons: ["approval: a human did not approve this payment (above APPROVAL_THRESHOLD_USDC)"], approval: "denied", overridden: [] };
}
