// Tests for the robot's spoken lines: built from event data, not fixed numbers.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { approvalLine, lowBatteryLine, moneyWords, numberWords, paidLine, planLine, refusedLine, spokenName, statusLine } from "./voice-lines.js";

describe("spoken lines", () => {
  test("low battery uses the real battery level", () => {
    assert.equal(lowBatteryLine({ batteryPct: 18 }), "Battery at 18 percent. Looking for a charger.");
    assert.equal(lowBatteryLine({ batteryPct: 7.6 }), "Battery at 8 percent. Looking for a charger.");
  });

  test("plan names the charger, the minutes and the price", () => {
    assert.equal(
      planLine({ chargerName: "Congress Ave Robot Dock", isClosest: true, minutes: 15, amount: 200_000 }),
      "Congress Avenue dock is closest. Buying fifteen minutes for twenty cents.",
    );
    assert.equal(
      planLine({ chargerName: "East 6th St Dock", isClosest: true, minutes: 60, amount: 800_000 }),
      "East 6th Street dock is closest. Buying sixty minutes for eighty cents.",
    );
  });

  test('plan only says "closest" when the charger really is the nearest idle one', () => {
    assert.equal(
      planLine({ chargerName: "South Congress Charging Bay", isClosest: false, minutes: 30, amount: 1_200_000 }),
      "I picked South Congress charging bay. Buying thirty minutes for one dollar twenty.",
    );
  });

  test("approval, paid and refused lines", () => {
    assert.equal(approvalLine(), "This payment is above my limit. I need your approval.");
    assert.equal(paidLine({ confirmedOnChain: true }), "Payment confirmed on Solana. Charging now.");
    assert.equal(paidLine({ confirmedOnChain: false }), "Payment settled. Charging now.");
    assert.equal(refusedLine({ reason: "per-tx: 0.20 USDC is over the 0.10 USDC per-payment limit (MAX_PER_TX_USDC)" }), "Payment refused: over my per-payment limit.");
    assert.equal(refusedLine({ reason: "daily: 0.20 USDC would bring 24h spending to 5.10 USDC" }), "Payment refused: over my daily budget.");
    assert.equal(refusedLine({ reason: "allowlist: recipient X is not on the allowlist" }), "Payment refused: that recipient is not on my allowlist.");
    assert.equal(refusedLine({ reason: "kill-switch: agent is paused" }), "Payment refused: payments are paused.");
    assert.equal(refusedLine({ reason: "approval: a human did not approve this payment" }), "Payment refused: it was not approved.");
    assert.equal(refusedLine({ reason: "something new" }), "Payment refused: a safety check failed.");
  });

  test("status reports battery, budget left and the last payment", () => {
    const robot = { batteryPct: 48, budgetLeft: "3800000" };
    assert.equal(
      statusLine({ robot, lastPayment: { amount: "200000", deviceId: "charger-001" }, chargerName: "Congress Ave Robot Dock" }),
      "Battery at 48 percent. Three dollars eighty of budget left. Last payment: twenty cents at Congress Avenue dock.",
    );
    assert.equal(statusLine({ robot, lastPayment: null }), "Battery at 48 percent. Three dollars eighty of budget left. No payments yet.");
    assert.equal(statusLine({ robot: null }), "I have no report from the robot yet.");
  });

  test("numbers and money are written as words", () => {
    assert.deepEqual([0, 7, 15, 20, 21, 30, 60, 99, 100, 120].map(numberWords), ["zero", "seven", "fifteen", "twenty", "twenty-one", "thirty", "sixty", "ninety-nine", "one hundred", "one hundred twenty"]);
    assert.equal(moneyWords(200_000), "twenty cents");
    assert.equal(moneyWords(10_000), "one cent");
    assert.equal(moneyWords(1_000_000), "one dollar");
    assert.equal(moneyWords(2_000_000), "two dollars");
    assert.equal(moneyWords("4800000"), "four dollars eighty");
  });

  test("charger names are said the way a person would say them", () => {
    assert.equal(spokenName("Congress Ave Robot Dock"), "Congress Avenue dock");
    assert.equal(spokenName("South Congress Charging Bay"), "South Congress charging bay");
    assert.equal(spokenName("East 6th St Dock"), "East 6th Street dock");
  });
});
