// Tests for the chargers as the server runs them: other robots come and go, a busy charger
// refuses a charge request before any price is quoted, and demo mode opens with the charger
// nearest to the robot in use.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { chargerOptions, planWithRules } from "../agent/planner.js";
import { Robot } from "../agent/robot.js";
import { DELIVERY_STOPS, NODES, deliveryLoopNodes } from "../agent/streets.js";
import {
  allDevices,
  chargeRefusal,
  getDevice,
  holdForQuote,
  listDevices,
  noteDiscovery,
  occupancyCheck,
  occupy,
  reserve,
  release,
  startCharging,
  startOccupancy,
  vacate,
} from "./devices.js";
import { OCCUPANCY } from "./occupancy.js";

const discovered = (id) => listDevices().find((device) => device.id === id);
const statuses = () => listDevices().map((device) => device.status);
const everyoneLeaves = () => allDevices().forEach(vacate);
const wantEverything = () => 0; // a "random" source under which every idle charger is wanted

after(() => {
  startOccupancy("off");
  everyoneLeaves();
});

describe("a charger in use by another robot", () => {
  test("shows as in_use in discovery, with the minutes until it is free", () => {
    startOccupancy("off");
    assert.deepEqual(statuses(), ["idle", "idle", "idle"]);
    assert.deepEqual([discovered("charger-001").minutesUntilFree, discovered("charger-001").freeAt], [0, null]);

    assert.equal(occupy(getDevice("charger-001"), 12), true);
    const busy = discovered("charger-001");
    assert.deepEqual([busy.status, busy.minutesUntilFree], ["in_use", 12]);
    assert.ok(Date.parse(busy.freeAt) > Date.now());
    assert.equal(discovered("charger-002").status, "idle");
  });

  test("answers a charge request with 409 'charger in use', so no 402 is ever issued for it", () => {
    const refusal = chargeRefusal(getDevice("charger-001"));
    assert.equal(refusal.status, 409);
    assert.deepEqual([refusal.body.error, refusal.body.message, refusal.body.status, refusal.body.minutesUntilFree], ["charger_in_use", "charger in use", "in_use", 12]);
    assert.equal(chargeRefusal(getDevice("charger-002")), null, "a free charger is not refused");
  });

  test("cannot be reserved for a payment, and cannot be taken twice", () => {
    assert.equal(reserve(getDevice("charger-001")), false);
    assert.equal(occupy(getDevice("charger-001"), 30), false);
    assert.equal(discovered("charger-001").minutesUntilFree, 12, "the first robot's time stands");
  });

  test("is idle again once the other robot leaves", () => {
    vacate(getDevice("charger-001"));
    assert.deepEqual([discovered("charger-001").status, discovered("charger-001").minutesUntilFree], ["idle", 0]);
    assert.equal(chargeRefusal(getDevice("charger-001")), null);
  });

  test("a charger held while a payment settles also refuses a second robot", () => {
    const device = getDevice("charger-002");
    assert.equal(reserve(device), true);
    assert.equal(chargeRefusal(device).status, 409);
    release(device);
    assert.equal(chargeRefusal(device), null);
  });
});

describe("occupancy modes", () => {
  test("off: nobody else ever takes a charger", () => {
    startOccupancy("off", { random: wantEverything });
    for (let check = 0; check < 20; check++) occupancyCheck();
    assert.deepEqual(statuses(), ["idle", "idle", "idle"]);
  });

  test("random: idle chargers get taken for 10 to 40 minutes, but never all of them", () => {
    startOccupancy("random", { random: wantEverything });
    for (let check = 0; check < 20; check++) occupancyCheck();
    assert.deepEqual(statuses(), ["in_use", "in_use", "idle"]);
    for (const device of listDevices().filter((d) => d.status === "in_use")) {
      assert.ok(device.minutesUntilFree >= OCCUPANCY.minMinutes && device.minutesUntilFree <= OCCUPANCY.maxMinutes);
    }
    everyoneLeaves();
  });

  test("random: a charger a robot was just quoted for is left alone while it pays", () => {
    startOccupancy("random", { random: wantEverything });
    holdForQuote(getDevice("charger-001"));
    occupancyCheck();
    assert.deepEqual(statuses(), ["idle", "in_use", "idle"], "the quoted charger stays free, and one more stays idle");
    everyoneLeaves();
    getDevice("charger-001").heldUntil = 0;
  });
});

describe("demo mode", () => {
  const CAPITOL = { lat: 30.2747, lng: -97.7404 };

  /** What a robot standing at `location` on 19% battery would plan, given what discovery says right now. */
  function planFrom(location) {
    const robot = new Robot({ id: "robot-test", location, startBatteryPct: 19, drainPctPerSecond: 0.5, drainPctPerKm: 5, chargePctPerMinute: 2 });
    const chargers = chargerOptions({
      batteryPct: 19,
      drainPctPerKm: 5,
      waitDrainPctPerMinute: 0.5,
      chargers: listDevices().map((d) => ({ id: d.id, name: d.name, status: d.status, minutesUntilFree: d.minutesUntilFree, distanceKm: robot.routeKmTo(d), priceUsdc: { 15: 0.2, 30: 0.4, 60: 0.8 } })),
    });
    const nearest = [...chargers].sort((a, b) => a.distanceKm - b.distanceKm)[0];
    return { nearest, plan: planWithRules({ chargers, budgetLeftUsdc: 5, targetBatteryPct: 45, chargePctPerMinute: 2 }) };
  }

  test("every charger is free until the robot first looks for one", () => {
    startOccupancy("demo");
    for (let check = 0; check < 50; check++) occupancyCheck();
    assert.deepEqual(statuses(), ["idle", "idle", "idle"]);
  });

  test("a discovery request without a position (a health check) does not start the show", () => {
    noteDiscovery(undefined);
    noteDiscovery({ lat: NaN, lng: NaN });
    assert.deepEqual(statuses(), ["idle", "idle", "idle"]);
  });

  test("on the first charge the nearest charger is in use, so the first choice skips it", () => {
    noteDiscovery(CAPITOL);
    const { nearest, plan } = planFrom(CAPITOL);
    assert.deepEqual([nearest.status, nearest.minutesUntilFree], ["in_use", OCCUPANCY.demoFirstBusyMinutes]);
    assert.equal(plan.action, "charge");
    assert.notEqual(plan.deviceId, nearest.id);
    assert.match(plan.reason, / busy 25 min; .* is free and reachable at \d+%/);
    assert.equal(statuses().filter((status) => status === "idle").length, 2, "the other two are free");
  });

  test("only the first discovery is scripted", () => {
    const before = statuses();
    noteDiscovery({ lat: 30.2497, lng: -97.7494 }); // right next to another charger
    assert.deepEqual(statuses(), before);
  });

  test("wherever on its loop the robot runs low, the charger nearest to it is the busy one", () => {
    for (const nodeId of deliveryLoopNodes(DELIVERY_STOPS)) {
      everyoneLeaves();
      startOccupancy("demo");
      const location = { lat: NODES[nodeId].lat, lng: NODES[nodeId].lng };
      noteDiscovery(location);
      const { nearest, plan } = planFrom(location);
      assert.equal(nearest.status, "in_use", `at ${nodeId} the nearest charger (${nearest.id}) should be busy`);
      assert.equal(plan.action, "charge", nodeId);
      assert.notEqual(plan.deviceId, nearest.id, nodeId);
    }
    everyoneLeaves();
  });

  test("after the opening, the same seed takes the same chargers for the same times", () => {
    const run = () => {
      everyoneLeaves();
      startOccupancy("demo");
      noteDiscovery(CAPITOL);
      const taken = [];
      for (let check = 0; check < 60; check++) {
        occupancyCheck();
        taken.push(listDevices().map((d) => `${d.status}:${d.minutesUntilFree}`).join(" "));
        if (check % 7 === 6) everyoneLeaves(); // time passes: the chargers free up
      }
      return taken;
    };
    assert.deepEqual(run(), run());
    everyoneLeaves();
  });
});

describe("a paid session", () => {
  test("shows as charging_<robot> with the time left, and refuses other robots", () => {
    startOccupancy("off");
    const device = getDevice("charger-003");
    startCharging(device, 15, "FakeSignature", "robot-01");
    const shown = discovered("charger-003");
    assert.deepEqual([shown.status, shown.minutesUntilFree], ["charging_robot-01", 15]);
    assert.equal(chargeRefusal(device).body.message, "charger in use");
    assert.equal(occupy(device, 10), false, "another robot cannot take a charger that is charging");
  });
});
