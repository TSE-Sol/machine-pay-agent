// Tests for the planner: it weighs free, busy and out-of-reach chargers, never sends the robot
// to a charger it cannot reach, and waits when waiting is the only sound move.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MIN_ARRIVAL_BATTERY_PCT, chargerOptions, makePlan, planWithRules } from "./planner.js";

const PRICE = { 15: 0.2, 30: 0.4, 60: 0.8 };
const charger = (id, name, distanceKm, status = "idle", minutesUntilFree = 0) => ({ id, name, status, minutesUntilFree, distanceKm, priceUsdc: PRICE });
const congress = (status, minutes) => charger("charger-001", "Congress Ave Robot Dock", 0.6, status, minutes);
const east6th = (status, minutes) => charger("charger-003", "East 6th St Dock", 1.8, status, minutes);
const southCongress = (status, minutes) => charger("charger-002", "South Congress Charging Bay", 2.6, status, minutes);

/** The planner's input for a robot at `batteryPct`: the drive costs 5% per km, waiting 0.5% per minute. */
const input = (batteryPct, chargers) => ({
  robot: { batteryPct },
  chargers: chargerOptions({ batteryPct, chargers, drainPctPerKm: 5, waitDrainPctPerMinute: 0.5 }),
  budgetLeftUsdc: 5,
  targetBatteryPct: 45,
  chargePctPerMinute: 2,
  drainPctPerKm: 5,
  waitDrainPctPerMinute: 0.5,
});
const noKey = { apiKey: "", model: "test-model" };
const withLlm = (llm) => ({ apiKey: "test-key", model: "test-model", llm });

describe("the options the planner weighs", () => {
  test("each charger gets the cost of the drive and what is left on arrival", () => {
    const [near, far] = chargerOptions({ batteryPct: 19, chargers: [congress(), southCongress()], drainPctPerKm: 5, waitDrainPctPerMinute: 0.5 });
    assert.deepEqual([near.free, near.distanceKm, near.drainToReachPct, near.batteryOnArrivalPct, near.reachable], [true, 0.6, 3, 16, true]);
    assert.deepEqual([far.drainToReachPct, far.batteryOnArrivalPct, far.reachable], [13, 6, true]);
    assert.equal(near.ifWait, undefined, "a free charger has nothing to wait for");
  });

  test("a charger is out of reach when the drive would leave less than the minimum", () => {
    const [far] = chargerOptions({ batteryPct: 13.5, chargers: [southCongress()], drainPctPerKm: 5 });
    assert.equal(far.batteryOnArrivalPct, 0.5);
    assert.equal(far.reachable, false);
    const [justEnough] = chargerOptions({ batteryPct: 13 + MIN_ARRIVAL_BATTERY_PCT, chargers: [southCongress()], drainPctPerKm: 5 });
    assert.equal(justEnough.reachable, true);
  });

  test("a busy charger also gets what waiting for it would leave", () => {
    const [busy] = chargerOptions({ batteryPct: 19, chargers: [congress("in_use", 12)], drainPctPerKm: 5, waitDrainPctPerMinute: 0.5 });
    assert.deepEqual([busy.free, busy.minutesUntilFree, busy.reachable], [false, 12, true]);
    assert.deepEqual(busy.ifWait, { batteryOnArrivalPct: 10, reachable: true }); // 19 - 3 for the drive - 6 for the wait
    const [tooLong] = chargerOptions({ batteryPct: 19, chargers: [congress("in_use", 40)], drainPctPerKm: 5, waitDrainPctPerMinute: 0.5 });
    assert.deepEqual(tooLong.ifWait, { batteryOnArrivalPct: -4, reachable: false });
  });

  test("a charger charging some robot counts as busy", () => {
    const [taken] = chargerOptions({ batteryPct: 19, chargers: [congress("charging_robot-02", 9)], drainPctPerKm: 5 });
    assert.equal(taken.free, false);
  });
});

describe("rule-based planner", () => {
  test("picks the nearest free charger in reach", () => {
    const plan = planWithRules(input(19, [southCongress(), congress(), east6th()]));
    assert.deepEqual([plan.action, plan.deviceId], ["charge", "charger-001"]);
    assert.match(plan.reason, /nearest free dock, 0\.6 km, reachable at 16%/);
  });

  test("buys the shortest session that reaches the target from the arrival level", () => {
    assert.equal(planWithRules(input(19, [congress()])).minutes, 15); // arrives at 16%, +30% = 46%
    assert.equal(planWithRules(input(19, [southCongress()])).minutes, 30); // arrives at 6%: 15 min is not enough
  });

  test("the nearest charger is busy: goes to the next free one, and says why", () => {
    const plan = planWithRules(input(19, [congress("in_use", 12), east6th(), southCongress()]));
    assert.deepEqual([plan.action, plan.deviceId], ["charge", "charger-003"]);
    assert.equal(plan.reason, "Congress Ave busy 12 min; East 6th St is free and reachable at 10%");
  });

  test("never picks a free charger the robot cannot reach", () => {
    // 8% battery: East 6th (9% away) and South Congress (13% away) are out of reach.
    const plan = planWithRules(input(8, [congress("in_use", 4), east6th(), southCongress()]));
    assert.deepEqual([plan.action, plan.deviceId], ["wait", "charger-001"]);
    for (const battery of [3, 5, 8, 9, 12, 14, 19]) {
      const options = input(battery, [congress(), east6th(), southCongress()]);
      const chosen = options.chargers.find((c) => c.id === planWithRules(options)?.deviceId);
      if (chosen) assert.equal(chosen.reachable, true, `at ${battery}% it chose ${chosen.id}`);
    }
  });

  test("no free charger in reach: waits for whichever frees soonest", () => {
    const plan = planWithRules(input(19, [congress("in_use", 12), east6th("in_use", 5), southCongress("charging_robot-02", 9)]));
    assert.deepEqual([plan.action, plan.deviceId], ["wait", "charger-003"]);
    assert.match(plan.reason, /East 6th St frees soonest, in 5 min, and is reachable at 7% after the wait/);
  });

  test("it does not wait for a charger it could not reach after the wait", () => {
    // East 6th frees first, but after 5 minutes of waiting the robot could no longer drive there.
    const plan = planWithRules(input(11, [congress("in_use", 12), east6th("in_use", 5)]));
    assert.deepEqual([plan.action, plan.deviceId], ["wait", "charger-001"]);
  });

  test("nothing in reach, now or after waiting: no plan at all", () => {
    assert.equal(planWithRules(input(3, [congress("in_use", 12), east6th(), southCongress()])), null);
    assert.equal(planWithRules(input(19, [])), null);
  });

  test("a free charger in reach always beats waiting", () => {
    const plan = planWithRules(input(19, [congress("in_use", 1), southCongress()]));
    assert.deepEqual([plan.action, plan.deviceId], ["charge", "charger-002"]);
  });
});

describe("makePlan (whichever planner answers, the plan is checked in code)", () => {
  test("without an API key the rules decide", async () => {
    const plan = await makePlan(input(19, [congress("in_use", 12), east6th()]), noKey);
    assert.deepEqual([plan.planner, plan.action, plan.deviceId], ["rules", "charge", "charger-003"]);
  });

  test("Claude may choose to wait for a closer busy charger", async () => {
    const llm = async () => ({ action: "wait", deviceId: "charger-001", minutes: 15, reason: "Congress Ave frees in 2 min; closer than East 6th." });
    const plan = await makePlan(input(19, [congress("in_use", 2), east6th()]), withLlm(llm));
    assert.deepEqual([plan.planner, plan.action, plan.deviceId], ["claude", "wait", "charger-001"]);
  });

  test("Claude may choose a farther free charger", async () => {
    const llm = async () => ({ action: "charge", deviceId: "charger-003", minutes: 30, reason: "Congress Ave busy 12 min; East 6th is free and reachable at 10%." });
    const plan = await makePlan(input(19, [congress("in_use", 12), east6th()]), withLlm(llm));
    assert.deepEqual([plan.planner, plan.action, plan.deviceId, plan.minutes], ["claude", "charge", "charger-003", 30]);
  });

  test("Claude is shown each charger's distance, status, wait, price and drain, and the battery level", async () => {
    let seen;
    const llm = async (given) => ((seen = given), { action: "charge", deviceId: "charger-003", minutes: 15, reason: "ok" });
    await makePlan(input(19, [congress("in_use", 12), east6th()]), withLlm(llm));
    assert.equal(seen.robot.batteryPct, 19);
    const busy = seen.chargers.find((c) => c.id === "charger-001");
    for (const field of ["distanceKm", "status", "minutesUntilFree", "priceUsdc", "drainToReachPct", "batteryOnArrivalPct", "reachable", "ifWait"]) {
      assert.notEqual(busy[field], undefined, field);
    }
  });

  const rejected = {
    "a charger out of reach": [8, [congress(), southCongress()], { action: "charge", deviceId: "charger-002", minutes: 15, reason: "far" }],
    "a busy charger, to pay at now": [19, [congress("in_use", 12), east6th()], { action: "charge", deviceId: "charger-001", minutes: 15, reason: "closest" }],
    "a wait it could not survive": [19, [congress("in_use", 40), east6th()], { action: "wait", deviceId: "charger-001", minutes: 15, reason: "wait" }],
    "a wait for a charger that is free": [19, [congress(), east6th()], { action: "wait", deviceId: "charger-001", minutes: 15, reason: "wait" }],
    "a charger that does not exist": [19, [congress()], { action: "charge", deviceId: "charger-999", minutes: 15, reason: "?" }],
    "an action that does not exist": [19, [congress()], { action: "teleport", deviceId: "charger-001", minutes: 15, reason: "?" }],
  };
  for (const [what, [battery, chargers, answer]] of Object.entries(rejected)) {
    test(`Claude choosing ${what} is ignored, and the rules decide`, async () => {
      const options = input(battery, chargers);
      const plan = await makePlan(options, withLlm(async () => answer));
      assert.equal(plan.planner, "rules");
      assert.equal(plan.note, "claude returned an unusable plan");
      assert.deepEqual(plan.deviceId, planWithRules(options).deviceId);
    });
  }

  test("with nothing usable there is no plan, and Claude is not even asked", async () => {
    let asked = 0;
    const plan = await makePlan(input(3, [congress("in_use", 12), east6th()]), withLlm(async () => (asked++, {})));
    assert.deepEqual([plan, asked], [null, 0]);
  });
});
