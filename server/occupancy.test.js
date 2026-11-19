// Tests for the "other robots" rules: which idle chargers get taken, for how long, and the
// promise that the chargers are never all taken at once.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OCCUPANCY, OCCUPANCY_MODES, demoOpening, pickOccupancies, seededRandom } from "./occupancy.js";

const allIdle = () => ["charger-001", "charger-002", "charger-003"].map((id) => ({ id, idle: true }));
const always = () => 0; // every idle charger is wanted, for the shortest time
const never = () => 0.999;

describe("random occupancy", () => {
  test("the three modes are off, random and demo", () => {
    assert.deepEqual(OCCUPANCY_MODES, ["off", "random", "demo"]);
  });

  test("an idle charger is sometimes taken, for 10 to 40 simulated minutes", () => {
    const random = seededRandom(7);
    const minutes = [];
    for (let check = 0; check < 2000; check++) minutes.push(...pickOccupancies(allIdle(), { random }).map((taken) => taken.minutes));
    assert.ok(minutes.length > 100, "chargers do get taken");
    assert.ok(Math.min(...minutes) >= 10 && Math.max(...minutes) <= 40, `durations were ${Math.min(...minutes)} to ${Math.max(...minutes)} min`);
    assert.ok(new Set(minutes).size > 15, "durations vary");
  });

  test("with no luck, nothing is taken", () => {
    assert.deepEqual(pickOccupancies(allIdle(), { random: never }), []);
  });

  test("the last idle charger is never taken, even when every charger is wanted", () => {
    assert.deepEqual(pickOccupancies(allIdle(), { random: always }).map((taken) => taken.id), ["charger-001", "charger-002"]);
    const oneBusy = [{ id: "charger-001", idle: false }, { id: "charger-002", idle: true }, { id: "charger-003", idle: true }];
    assert.deepEqual(pickOccupancies(oneBusy, { random: always }).map((taken) => taken.id), ["charger-002"]);
    const twoBusy = [{ id: "charger-001", idle: false }, { id: "charger-002", idle: false }, { id: "charger-003", idle: true }];
    assert.deepEqual(pickOccupancies(twoBusy, { random: always }), []);
  });

  test("over a long run the chargers are never all in use at once", () => {
    const random = seededRandom(42);
    const busyUntil = { "charger-001": 0, "charger-002": 0, "charger-003": 0 }; // simulated minute each one frees up
    let mostBusy = 0;
    for (let minute = 0; minute < 50_000; minute += OCCUPANCY.checkEveryMinutes) {
      const chargers = Object.keys(busyUntil).map((id) => ({ id, idle: busyUntil[id] <= minute }));
      for (const { id, minutes } of pickOccupancies(chargers, { random })) busyUntil[id] = minute + minutes;
      const busy = Object.values(busyUntil).filter((until) => until > minute).length;
      mostBusy = Math.max(mostBusy, busy);
      assert.ok(busy < 3, `all three were in use at minute ${minute}`);
    }
    assert.equal(mostBusy, 2, "two at once does happen, so the agent has something to weigh");
  });
});

describe("demo mode", () => {
  test("the seeded generator repeats exactly, so every demo run plays alike", () => {
    const a = seededRandom(OCCUPANCY.demoSeed);
    const b = seededRandom(OCCUPANCY.demoSeed);
    const first = Array.from({ length: 50 }, a);
    assert.deepEqual(first, Array.from({ length: 50 }, b));
    assert.ok(first.every((value) => value >= 0 && value < 1));
    assert.notDeepEqual(first.slice(0, 5), Array.from({ length: 5 }, seededRandom(1)));
  });

  test("the opening move takes the charger nearest to the robot", () => {
    const chargers = [
      { id: "charger-001", idle: true, meters: 900 },
      { id: "charger-002", idle: true, meters: 400 },
      { id: "charger-003", idle: true, meters: 1500 },
    ];
    assert.deepEqual(demoOpening(chargers), { id: "charger-002", minutes: OCCUPANCY.demoFirstBusyMinutes });
  });

  test("the opening move never leaves the robot without a free charger", () => {
    const onlyNearestFree = [
      { id: "charger-001", idle: true, meters: 400 },
      { id: "charger-002", idle: false, meters: 900 },
      { id: "charger-003", idle: false, meters: 1500 },
    ];
    assert.equal(demoOpening(onlyNearestFree), null);
    const nearestAlreadyBusy = [
      { id: "charger-001", idle: false, meters: 400 },
      { id: "charger-002", idle: true, meters: 900 },
      { id: "charger-003", idle: true, meters: 1500 },
    ];
    assert.equal(demoOpening(nearestAlreadyBusy), null);
  });
});
