// Unit tests for every guardrail. Run with `npm test`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  authorizePayment,
  budgetNextResetAt,
  checkAllowlist,
  checkDailyBudget,
  checkKillSwitch,
  checkPerTx,
  checkPrice,
  checkRateLimit,
  evaluatePayment,
  needsApproval,
  parseAmount,
} from "./guardrails.js";

const MERCHANT = "AsCyNEGaHqxeyoJQkW5AXdDeTJpN9SiPviWY8sNiVG5w";
const ATTACKER = "7cpH5zEAFUJTszSLXk3Uz5qedVkmxE2RJwbPHZbRM9hH";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NOW = Date.parse("2026-11-13T12:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const limits = (overrides = {}) => ({
  paused: false,
  maxPerTx: 1_000_000n, // 1.00 USDC
  dailyBudget: 5_000_000n, // 5.00 USDC
  approvalThreshold: 500_000n, // 0.50 USDC
  maxPaymentsPer10Min: 5,
  allowedPayTo: [MERCHANT],
  allowedNetworks: [DEVNET],
  allowedAssets: [USDC],
  ...overrides,
});

// An honest 402 for a 15-minute session at the advertised 0.20 USDC.
const honestQuote = (overrides = {}) => ({
  scheme: "exact",
  network: DEVNET,
  asset: USDC,
  payTo: MERCHANT,
  amount: "200000",
  ...overrides,
});

const evaluate = (overrides = {}) =>
  evaluatePayment({ quote: honestQuote(), expectedAmount: 200_000n, limits: limits(), payments: [], now: NOW, ...overrides });

const paid = (minutesAgo, amount = 200_000n) => ({ time: NOW - minutesAgo * MINUTE, amount });
const failedCheck = (evaluation, name) => evaluation.checks.find((check) => check.name === name && !check.ok);

describe("an honest payment request", () => {
  test("passes every guardrail and needs no approval", () => {
    const result = evaluate();
    assert.equal(result.allowed, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.needsApproval, false);
    assert.deepEqual(result.checks.map((c) => c.name), ["kill-switch", "allowlist", "price", "per-tx", "daily", "rate-limit"]);
  });
});

describe("MAX_PER_TX_USDC", () => {
  test("allows a payment exactly at the limit", () => {
    assert.equal(checkPerTx(1_000_000n, limits()).ok, true);
  });
  test("rejects a payment one base unit over the limit", () => {
    const check = checkPerTx(1_000_001n, limits());
    assert.equal(check.ok, false);
    assert.match(check.reason, /per-payment limit \(MAX_PER_TX_USDC\)/);
  });
  test("rejects 0.20 USDC when the limit is lowered to 0.10", () => {
    const result = evaluate({ limits: limits({ maxPerTx: 100_000n }) });
    assert.equal(result.allowed, false);
    assert.match(failedCheck(result, "per-tx").reason, /0\.20 USDC is over the 0\.10 USDC/);
  });
});

describe("DAILY_BUDGET_USDC", () => {
  test("allows spending up to exactly the budget", () => {
    const history = [paid(60, 4_800_000n)]; // 4.80 spent, +0.20 = 5.00
    assert.equal(checkDailyBudget(200_000n, history, limits(), NOW).ok, true);
  });
  test("rejects a payment that would go over the budget", () => {
    const history = [paid(60, 4_900_000n)]; // 4.90 spent, +0.20 = 5.10
    const check = checkDailyBudget(200_000n, history, limits(), NOW);
    assert.equal(check.ok, false);
    assert.match(check.reason, /5\.10 USDC, over the 5\.00 USDC budget \(DAILY_BUDGET_USDC\)/);
  });
  test("forgets payments older than 24 hours", () => {
    const history = [{ time: NOW - 25 * HOUR, amount: 4_900_000n }];
    assert.equal(checkDailyBudget(200_000n, history, limits(), NOW).ok, true);
  });
  test("adds up many small payments", () => {
    const history = Array.from({ length: 25 }, (_, i) => paid(30 + i)); // 25 x 0.20 = 5.00
    assert.equal(evaluate({ payments: history, limits: limits({ maxPaymentsPer10Min: 100 }) }).allowed, false);
  });
});

describe("when the budget frees up", () => {
  test("it is 24 hours after the oldest payment that still counts", () => {
    const history = [paid(23 * 60), paid(60), paid(5), { time: NOW - 30 * HOUR, amount: 200_000n }];
    assert.equal(budgetNextResetAt(history, NOW), NOW - 23 * HOUR + 24 * HOUR); // the 23-hour-old payment expires in 1 hour
  });
  test("there is nothing to wait for when nothing was spent in the last 24 hours", () => {
    assert.equal(budgetNextResetAt([], NOW), null);
    assert.equal(budgetNextResetAt([{ time: NOW - 25 * HOUR, amount: 200_000n }], NOW), null);
  });
});

describe("allowlist", () => {
  test("accepts the configured merchant, network and token", () => {
    assert.equal(checkAllowlist(honestQuote(), limits()).ok, true);
  });
  test("rejects an unknown recipient", () => {
    const check = checkAllowlist(honestQuote({ payTo: ATTACKER }), limits());
    assert.equal(check.ok, false);
    assert.match(check.reason, /recipient .* is not on the allowlist/);
  });
  test("rejects another network (mainnet)", () => {
    assert.match(checkAllowlist(honestQuote({ network: MAINNET }), limits()).reason, /network .* is not on the allowlist/);
  });
  test("rejects another token", () => {
    const check = checkAllowlist(honestQuote({ asset: "So11111111111111111111111111111111111111112" }), limits());
    assert.match(check.reason, /token .* is not on the allowlist/);
  });
  test("rejects a payment scheme other than exact", () => {
    assert.match(checkAllowlist(honestQuote({ scheme: "upto" }), limits()).reason, /scheme "upto" is not allowed/);
  });
  test("rejects everything when the allowlist is empty", () => {
    assert.equal(checkAllowlist(honestQuote(), limits({ allowedPayTo: [] })).ok, false);
  });
});

describe("price sanity", () => {
  test("accepts the advertised price", () => {
    assert.equal(checkPrice(200_000n, 200_000n).ok, true);
  });
  test("rejects a higher price than advertised", () => {
    const check = checkPrice(250_000n, 200_000n);
    assert.equal(check.ok, false);
    assert.match(check.reason, /402 asks for 0\.25 USDC but the advertised price is 0\.20 USDC/);
  });
  test("rejects a lower price than advertised too (any mismatch is suspicious)", () => {
    assert.equal(checkPrice(100_000n, 200_000n).ok, false);
  });
  test("rejects amounts that are not plain positive integers", () => {
    for (const bad of ["0", "-200000", "0.2", "2e5", "", "abc", 200000, null, undefined]) {
      assert.equal(parseAmount(bad), null, `parseAmount(${JSON.stringify(bad)})`);
    }
    assert.equal(checkPrice(parseAmount("0.2"), 200_000n).ok, false);
  });
});

describe("fake 402: a tampered payment request is refused", () => {
  test("amount inflated from 0.20 to 0.90 USDC (still under the per-tx cap)", () => {
    const result = evaluate({ quote: honestQuote({ amount: "900000" }) });
    assert.equal(result.allowed, false);
    assert.ok(failedCheck(result, "price"), "price check must fail");
    assert.equal(failedCheck(result, "per-tx"), undefined, "per-tx alone would not have caught this");
  });
  test("payTo swapped for an attacker's wallet, price left correct", () => {
    const result = evaluate({ quote: honestQuote({ payTo: ATTACKER }) });
    assert.equal(result.allowed, false);
    assert.ok(failedCheck(result, "allowlist"));
    assert.equal(failedCheck(result, "price"), undefined, "the price looked fine");
  });
  test("network switched to mainnet", () => {
    assert.equal(evaluate({ quote: honestQuote({ network: MAINNET }) }).allowed, false);
  });
  test("amount and payTo both tampered: every broken rule is reported", () => {
    const result = evaluate({ quote: honestQuote({ amount: "50000000", payTo: ATTACKER }) });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ["allowlist", "price", "per-tx", "daily"]);
    assert.equal(result.reasons.length, 4);
  });
  test("a malformed amount is refused, not treated as zero", () => {
    const result = evaluate({ quote: honestQuote({ amount: "free" }) });
    assert.equal(result.allowed, false);
    assert.ok(failedCheck(result, "price"));
  });
});

describe("human approval (APPROVAL_THRESHOLD_USDC)", () => {
  const big = () => evaluate({ quote: honestQuote({ amount: "800000" }), expectedAmount: 800_000n }); // 60 min, 0.80 USDC

  test("is not needed at or below the threshold", () => {
    assert.equal(needsApproval(500_000n, limits()), false);
    assert.equal(needsApproval(200_000n, limits()), false);
  });
  test("is needed above the threshold", () => {
    assert.equal(needsApproval(500_001n, limits()), true);
    assert.equal(big().needsApproval, true);
  });
  test("small payment: goes ahead without asking anyone", async () => {
    let asked = 0;
    const decision = await authorizePayment(evaluate(), async () => (asked++, true));
    assert.deepEqual([decision.approved, decision.approval, asked], [true, "not-needed", 0]);
  });
  test("large payment: goes ahead when the human says yes", async () => {
    const decision = await authorizePayment(big(), async () => true);
    assert.deepEqual([decision.approved, decision.approval], [true, "granted"]);
  });
  test("large payment: refused when the human says no", async () => {
    const decision = await authorizePayment(big(), async () => false);
    assert.deepEqual([decision.approved, decision.approval], [false, "denied"]);
    assert.match(decision.reasons[0], /human did not approve/);
  });
  test("anything other than an explicit yes counts as no", async () => {
    for (const answer of [undefined, null, "yes", 1]) {
      assert.equal((await authorizePayment(big(), async () => answer)).approved, false);
    }
  });
  test("a human cannot approve a payment the guardrails refused (never even asked)", async () => {
    let asked = 0;
    const tampered = evaluate({ quote: honestQuote({ amount: "800000", payTo: ATTACKER }), expectedAmount: 800_000n });
    const decision = await authorizePayment(tampered, async () => (asked++, true));
    assert.deepEqual([decision.approved, asked], [false, 0]);
  });
});

describe("rate limit (MAX_PAYMENTS_PER_10_MIN)", () => {
  test("allows a payment while under the limit", () => {
    assert.equal(checkRateLimit([paid(1), paid(2), paid(3), paid(4)], limits(), NOW).ok, true);
  });
  test("rejects once the limit is reached", () => {
    const check = checkRateLimit([paid(1), paid(2), paid(3), paid(4), paid(5)], limits(), NOW);
    assert.equal(check.ok, false);
    assert.match(check.reason, /5 payments in the last 10 minutes \(limit 5, MAX_PAYMENTS_PER_10_MIN\)/);
  });
  test("ignores payments older than 10 minutes", () => {
    assert.equal(checkRateLimit([paid(11), paid(12), paid(13), paid(14), paid(15)], limits(), NOW).ok, true);
  });
});

describe("kill switch (AGENT_PAUSED)", () => {
  test("off: payments allowed", () => {
    assert.equal(checkKillSwitch(limits()).ok, true);
  });
  test("on: refuses even a perfectly valid payment", () => {
    const result = evaluate({ limits: limits({ paused: true }) });
    assert.equal(result.allowed, false);
    assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ["kill-switch"]);
    assert.match(result.reasons[0], /AGENT_PAUSED=true/);
  });
});
