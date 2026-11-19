// What the robot says. Every line is built from real event data (battery level, the
// chosen charger, the price), never from fixed numbers. Pure functions: no I/O here.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0..999 as words: 15 -> "fifteen", 120 -> "one hundred twenty". Larger numbers stay as digits. */
export function numberWords(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 999) return String(value);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
}

/** USDC base units as spoken money: 200000 -> "twenty cents", 1200000 -> "one dollar twenty". */
export function moneyWords(baseUnits) {
  const cents = Math.round(Number(baseUnits) / 10_000);
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  if (dollars === 0) return `${numberWords(rest)} ${rest === 1 ? "cent" : "cents"}`;
  const dollarWords = `${numberWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
  return rest === 0 ? dollarWords : `${dollarWords} ${numberWords(rest)}`;
}

/** A charger's name the way a person would say it: "Congress Ave Robot Dock" -> "Congress Avenue dock". */
export function spokenName(name) {
  return String(name)
    .replace(/\bAve\b\.?/g, "Avenue")
    .replace(/\bSt\b\.?/g, "Street")
    .replace(/\bRobot\s+/g, "")
    .replace(/\b(Dock|Charging Bay|Bay)\b/g, (word) => word.toLowerCase())
    .trim();
}

export function lowBatteryLine({ batteryPct }) {
  return `Battery at ${Math.round(batteryPct)} percent. Looking for a charger.`;
}

const capitalized = (sentence) => sentence.charAt(0).toUpperCase() + sentence.slice(1);

/**
 * isClosest: whether the chosen charger really is the nearest idle one.
 * busyName: a closer charger that was passed over because it is in use, if there is one.
 */
export function planLine({ chargerName, isClosest, minutes, amount, busyName = null }) {
  const choice = busyName
    ? `${spokenName(busyName)} is busy. Going to ${spokenName(chargerName)}.`
    : isClosest
      ? `${spokenName(chargerName)} is closest.`
      : `I picked ${spokenName(chargerName)}.`;
  return capitalized(`${choice} Buying ${numberWords(minutes)} minutes for ${moneyWords(amount)}.`);
}

/** Said when the agent decides to wait for a busy charger instead of paying anywhere. */
export function waitLine({ chargerName, minutes }) {
  const n = Math.max(1, Math.round(minutes));
  return capitalized(`${spokenName(chargerName)} is busy. Waiting ${numberWords(n)} ${n === 1 ? "minute" : "minutes"} for it.`);
}

export function approvalLine() {
  return "This payment is above my limit. I need your approval.";
}

const LIMIT_REACHED = { "rate-limit": "Rate limit", daily: "Daily budget" };

/**
 * Said when the battery is critically low and only a soft limit blocks the charge.
 * exceeded: the names of the limits in the way, e.g. ["rate-limit"].
 */
export function emergencyLine({ batteryPct, exceeded }) {
  const limits = exceeded.map((name) => LIMIT_REACHED[name]).filter(Boolean);
  const reached = limits.length === 0 ? "A spending limit" : limits.length === 1 ? limits[0] : `${limits[0]} and ${limits[1].toLowerCase()}`;
  return `Battery at ${Math.round(batteryPct)} percent. ${reached} reached. Approve an emergency charge?`;
}

/** confirmedOnChain: an independent check (RPC or QuickNode Streams) saw the payment land. */
export function paidLine({ confirmedOnChain }) {
  return confirmedOnChain ? "Payment confirmed on Solana. Charging now." : "Payment settled. Charging now.";
}

const REFUSAL_PHRASES = {
  "per-tx": "over my per-payment limit",
  allowlist: "that recipient is not on my allowlist",
  price: "the price does not match what was advertised",
  "rate-limit": "too many payments in the last ten minutes",
  "kill-switch": "payments are paused",
  approval: "it was not approved",
  requote: "the charger changed its terms",
};

/** Said when the daily budget guardrail stops a payment. */
export const DAILY_BUDGET_LINE = "Daily budget reached. I'll stop buying power until it resets.";

/** What the Preview button says, so a voice can be heard before it is used. */
export const PREVIEW_LINE = "Voice check. This is how I sound when I pay for my own power.";

/** reason: the agent's refusal reason, e.g. "per-tx: 0.20 USDC is over the 0.10 USDC ...". */
export function refusedLine({ reason }) {
  const guardrail = String(reason ?? "").split(":")[0].trim();
  if (guardrail === "daily") return DAILY_BUDGET_LINE;
  return `Payment refused: ${REFUSAL_PHRASES[guardrail] ?? "a safety check failed"}.`;
}

/** The robot's answer to "status": battery, budget left, last payment. */
export function statusLine({ robot, lastPayment, chargerName }) {
  if (!robot) return "I have no report from the robot yet.";
  const budget = moneyWords(robot.budgetLeft);
  const parts = [`Battery at ${Math.round(robot.batteryPct)} percent.`, `${budget.charAt(0).toUpperCase()}${budget.slice(1)} of budget left.`];
  if (lastPayment) parts.push(`Last payment: ${moneyWords(lastPayment.amount)} at ${spokenName(chargerName ?? lastPayment.deviceId)}.`);
  else parts.push("No payments yet.");
  return parts.join(" ");
}
