// Tests for the robot's movement: it drives the delivery loop along the streets, drives to a
// charger (along the streets) only once a payment has settled, parks there, and stays put when
// no payment settles. Time is passed in, so nothing here waits.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Robot, distanceKm, moveToward } from "./robot.js";
import { DELIVERY_STOPS, EDGES, NODES, deliveryLoopNodes, isEdge, metersBetween, shortestPath } from "./streets.js";

const T0 = Date.parse("2026-11-18T12:00:00Z");
const SECOND = 1000;
const ONE_BLOCK = 250;
const CHARGERS = ["charger-001", "charger-002", "charger-003"];
const at = (nodeId) => ({ lat: NODES[nodeId].lat, lng: NODES[nodeId].lng });

/** A robot at Congress Ave & 6th St, cruising at 100 m/s (demo time), battery not draining unless asked. */
function robot(overrides = {}) {
  return new Robot({
    id: "robot-test",
    location: at("congress-ave-and-6th-st"),
    startBatteryPct: 50,
    drainPctPerSecond: 0,
    chargePctPerMinute: 2,
    speedMetersPerSecond: 100,
    now: T0,
    ...overrides,
  });
}

/** Is this position on a street, i.e. on the straight piece between two nodes joined by an edge? */
function onAStreet(location) {
  return EDGES.some(([a, b]) => Math.abs(metersBetween(NODES[a], location) + metersBetween(location, NODES[b]) - metersBetween(NODES[a], NODES[b])) < 1);
}

const expiresIn = (seconds, from) => new Date(from + seconds * SECOND).toISOString();
const pay = (r, charger, now, sessionSeconds = 15) => r.startCharging({ deviceId: charger, location: at(charger), minutes: 15, expiresAt: expiresIn(sessionSeconds, now), now });

describe("delivery loop", () => {
  test("it starts at the intersection nearest its configured position", () => {
    const capitol = { lat: 30.2747, lng: -97.7404 };
    const r = robot({ location: capitol });
    assert.equal(NODES[r.lastNode].name, "Congress Ave & 11th St");
    assert.deepEqual(r.location, at("congress-ave-and-11th-st"));
  });

  test("while delivering it moves toward its next stop at its cruising speed", () => {
    const r = robot();
    const before = { ...r.location };
    r.tick(T0 + 2 * SECOND); // 2 s at 100 m/s
    assert.equal(r.status, "delivering");
    assert.ok(metersBetween(before, r.location) > 150, "it has moved");
    const target = NODES[DELIVERY_STOPS[r.nextStop]];
    assert.ok(metersBetween(r.location, target) < metersBetween(before, target), "and is closer to its next stop");
  });

  test("it moves a little each tick, never jumping", () => {
    const r = robot();
    let previous = { ...r.location };
    for (let tick = 1; tick <= 60; tick++) {
      r.tick(T0 + tick * SECOND);
      const step = metersBetween(previous, r.location);
      assert.ok(step > 0 && step <= 101, `tick ${tick}: moved ${step.toFixed(1)} m`);
      previous = { ...r.location };
    }
  });

  test("every hop from node to node is a graph edge", () => {
    const r = robot();
    const passed = [r.lastNode];
    for (let tick = 1; tick <= 600; tick++) {
      r.tick(T0 + tick * 100); // 60 s in 0.1 s steps
      if (passed.at(-1) !== r.lastNode) passed.push(r.lastNode);
    }
    assert.ok(passed.length > 30);
    passed.slice(1).forEach((id, i) => assert.ok(isEdge(passed[i], id), `${passed[i]} -> ${id}`));
  });

  test("it is on a street at every moment, never cutting across a block", () => {
    const r = robot();
    for (let tick = 1; tick <= 500; tick++) {
      r.tick(T0 + tick * 100);
      assert.ok(onAStreet(r.location), `off the street at ${r.location.lat}, ${r.location.lng}`);
    }
  });

  test("it visits all eight delivery stops and comes round again", () => {
    const r = robot();
    const visits = [];
    for (let tick = 1; tick <= 1000; tick++) {
      r.tick(T0 + tick * 100); // 100 s: more than two 4.4 km laps
      if (DELIVERY_STOPS.includes(r.lastNode) && visits.at(-1) !== r.lastNode) visits.push(r.lastNode);
    }
    assert.equal(new Set(visits).size, 8, "visited every stop");
    assert.ok(visits.filter((stop) => stop === DELIVERY_STOPS[0]).length >= 2, "and came back to the first one");
  });

  test("the closest charger changes as the robot moves", () => {
    const closestTo = (location) => [...CHARGERS].sort((a, b) => distanceKm(location, NODES[a]) - distanceKm(location, NODES[b]))[0];
    const seen = new Set();
    const r = robot();
    for (let tick = 1; tick <= 50; tick++) {
      r.tick(T0 + tick * SECOND);
      seen.add(closestTo(r.snapshot().location));
    }
    assert.ok(seen.size >= 2 && seen.has("charger-001") && seen.has("charger-002"), `closest chargers seen around the loop: ${[...seen].join(", ")}`);
  });

  test("the battery keeps draining while it drives", () => {
    const r = robot({ drainPctPerSecond: 0.5 });
    r.tick(T0 + 10 * SECOND);
    assert.equal(r.batteryPct, 45);
  });
});

describe("no payment, no trip to the charger", () => {
  test("while seeking a charge the robot waits where it is", () => {
    const r = robot({ drainPctPerSecond: 0.5 });
    r.tick(T0 + 5 * SECOND);
    r.seekCharge(); // battery low: the agent starts looking for a charger
    const stoppedAt = { ...r.location };
    r.tick(T0 + 25 * SECOND);
    assert.deepEqual(r.location, stoppedAt);
    assert.equal(r.snapshot().motion.mode, "holding");
  });

  test("a failed or denied payment leaves it exactly where it was", () => {
    // The decision loop calls startCharging only after a payment settles. When a payment is
    // refused or fails it is never called, so this is everything that happens to the robot:
    const r = robot({ drainPctPerSecond: 0.5 });
    r.tick(T0 + 3 * SECOND);
    r.seekCharge();
    const where = { ...r.location };
    for (let tick = 4; tick <= 60; tick++) r.tick(T0 + tick * SECOND); // retries come and go, none settles
    assert.deepEqual(r.location, where, "did not move toward any charger");
    assert.equal(r.status, "seeking_charge");
    assert.equal(r.session, null);
    assert.ok(r.batteryPct < 50, "the battery kept draining meanwhile");
  });

  test("with a flat battery it stops for good", () => {
    const r = robot({ startBatteryPct: 2, drainPctPerSecond: 1 });
    r.tick(T0 + 5 * SECOND);
    assert.equal(r.status, "idle");
    const where = { ...r.location };
    r.tick(T0 + 30 * SECOND);
    assert.deepEqual(r.location, where);
    assert.equal(r.snapshot().motion.mode, "stopped");
  });
});

describe("after a payment settles", () => {
  /** A robot stopped part-way along a block by seekCharge, then paid for 15 s at a charger. */
  function paid({ charger = "charger-003", sessionSeconds = 15, driveFor = 7.3 } = {}) {
    const r = robot();
    r.tick(T0 + driveFor * SECOND);
    r.seekCharge();
    const start = T0 + 10 * SECOND;
    r.tick(start);
    const from = { ...r.location };
    pay(r, charger, start, sessionSeconds);
    return { r, start, from };
  }

  test("its route to the charger only uses graph edges and ends at the charger", () => {
    const { r } = paid();
    const nodes = r.plan.map((p) => p.node);
    assert.ok(nodes.every(Boolean), "every point on the route is a graph node");
    nodes.slice(1).forEach((id, i) => assert.ok(isEdge(nodes[i], id), `${nodes[i]} -> ${id}`));
    assert.equal(nodes.at(-1), "charger-003");
    assert.equal(r.snapshot().motion.mode, "to_charger");
    assert.equal(r.snapshot().motion.deviceId, "charger-003");
  });

  test("from the middle of a block it first goes to an intersection at one end of that block", () => {
    const { r, from } = paid();
    const first = r.plan[0];
    assert.equal(NODES[first.node].kind, "intersection");
    assert.ok(metersBetween(from, first) > 1 && metersBetween(from, first) < ONE_BLOCK, "it was mid-block, and the first point is within a block");
    assert.ok(onAStreet(from), "and it was on a street to begin with");
  });

  test("it picks the end of the block that makes the shorter trip", () => {
    const { r, from } = paid({ charger: "charger-003" });
    const taken = metersBetween(from, r.plan[0]) + shortestPath(r.plan[0].node, "charger-003").meters;
    // Find the two ends of the block it is on, and the trip length via each.
    const [a, b] = EDGES.find(([x, y]) => Math.abs(metersBetween(NODES[x], from) + metersBetween(from, NODES[y]) - metersBetween(NODES[x], NODES[y])) < 1);
    const viaEach = [a, b].map((end) => metersBetween(from, NODES[end]) + shortestPath(end, "charger-003").meters);
    assert.ok(Math.abs(taken - Math.min(...viaEach)) < 0.01);
  });

  test("on the way it is on a street at every moment, and no step of the route is longer than a block", () => {
    const { r, start } = paid();
    const route = [r.location, ...r.snapshot().motion.path];
    for (let i = 0; i + 1 < route.length; i++) assert.ok(metersBetween(route[i], route[i + 1]) <= ONE_BLOCK);
    for (let ms = 100; ms <= 4500; ms += 100) {
      r.tick(start + ms);
      assert.ok(onAStreet(r.location), `off the street ${ms} ms into the drive`);
    }
  });

  test("each second of the drive brings it closer along the route", () => {
    const { r, start } = paid();
    let left = r.snapshot().motion.path.reduce((sum, p, i, path) => sum + metersBetween(i ? path[i - 1] : r.location, p), 0);
    for (let s = 1; s <= 3; s++) {
      r.tick(start + s * SECOND);
      const path = r.snapshot().motion.path;
      const now = path.reduce((sum, p, i) => sum + metersBetween(i ? path[i - 1] : r.location, p), 0);
      assert.ok(now < left, `second ${s}: ${Math.round(now)} m to go`);
      left = now;
    }
  });

  test("it arrives, parks exactly at the charger and stays there while charging", () => {
    const { r, start } = paid();
    r.tick(start + 6 * SECOND);
    assert.deepEqual(r.location, at("charger-003"));
    assert.equal(r.snapshot().motion.mode, "parked");
    r.tick(start + 12 * SECOND);
    assert.deepEqual(r.location, at("charger-003"), "still parked");
    assert.equal(r.status, "charging");
  });

  test("it arrives within the first 30% of the paid session, speeding up if it must", () => {
    const { r, start } = paid({ charger: "charger-002", sessionSeconds: 15 }); // the far one, over the bridge
    r.tick(start + 4.5 * SECOND);
    assert.deepEqual(r.location, at("charger-002"));
    assert.ok(r.session.arrivedAt <= start + 4.5 * SECOND);
  });

  test("the battery holds on the way and only rises once it is plugged in", () => {
    const { r, start } = paid();
    const atPayment = r.batteryPct;
    r.tick(start + 1 * SECOND);
    assert.equal(r.batteryPct, atPayment, "no charge while still driving");
    r.tick(start + 10 * SECOND);
    assert.ok(r.batteryPct > atPayment, "charging once parked");
  });

  test("the drive to the charger costs battery, and charging starts from what is left on arrival", () => {
    const r = robot({ startBatteryPct: 20, drainPctPerKm: 5 });
    const km = r.routeKmTo({ id: "charger-002", location: at("charger-002") });
    assert.ok(km > 1, "South Congress is a real drive from Congress & 6th");
    pay(r, "charger-002", T0, 60);
    let lowest = 20;
    for (let second = 1; second <= 60; second++) {
      r.tick(T0 + second * SECOND);
      lowest = Math.min(lowest, r.batteryPct);
    }
    assert.ok(Math.abs(lowest - (20 - km * 5)) < 0.01, `arrived with ${lowest.toFixed(2)}%, expected ${(20 - km * 5).toFixed(2)}%`);
    assert.ok(Math.abs(r.batteryPct - (20 - km * 5 + 30)) < 0.01, "the paid 15 minutes add 30% on top of the arrival level");
  });

  test("asking how far a charger is does not move the robot or change its plans", () => {
    const r = robot();
    r.tick(T0 + 3 * SECOND);
    const before = JSON.stringify(r.snapshot());
    for (const charger of CHARGERS) {
      const km = r.routeKmTo({ id: charger, location: at(charger) });
      assert.ok(km >= distanceKm(r.location, at(charger)) - 0.001, "a street route is never shorter than the straight line");
    }
    assert.equal(JSON.stringify(r.snapshot()), before);
  });

  test("the distance it reports to a charger is the distance it then drives", () => {
    const r = robot({ drainPctPerKm: 1, startBatteryPct: 50 });
    r.tick(T0 + 2.5 * SECOND); // part-way along a block
    const start = T0 + 2.5 * SECOND;
    const km = r.routeKmTo({ id: "charger-003", location: at("charger-003") });
    pay(r, "charger-003", start, 60);
    r.tick(start + 18 * SECOND); // arrives within the first 30% of the session
    assert.equal(r.snapshot().motion.mode, "parked");
    assert.ok(Math.abs(r.session.fromPct - (50 - km)) < 0.01, "1% per km: the battery used equals the reported distance");
  });

  test("by the end of the session it has the full paid charge", () => {
    const { r, start } = paid();
    const atPayment = r.batteryPct;
    for (let s = 1; s <= 15; s++) r.tick(start + s * SECOND);
    assert.equal(r.batteryPct, atPayment + 30, "15 paid minutes at 2% per minute");
  });

  test("when charging finishes it drives back, along the streets, to the nearest delivery stop", () => {
    const { r, start } = paid();
    r.tick(start + 15 * SECOND);
    assert.equal(r.status, "delivering");
    assert.equal(r.session, null);
    const nearestByStreet = [...DELIVERY_STOPS].sort((a, b) => shortestPath("charger-003", a).meters - shortestPath("charger-003", b).meters)[0];
    assert.equal(DELIVERY_STOPS[r.nextStop], nearestByStreet);
    assert.equal(NODES[nearestByStreet].name, "Trinity St & E 6th St");
    for (let ms = 100; ms <= 6000; ms += 100) {
      r.tick(start + 15 * SECOND + ms);
      assert.ok(onAStreet(r.location), "on a street on the way back");
    }
  });

  test("from every point of the loop it reaches every charger and parks there", () => {
    for (const from of new Set(deliveryLoopNodes())) {
      for (const charger of CHARGERS) {
        const r = robot({ location: at(from) });
        r.seekCharge();
        pay(r, charger, T0);
        r.tick(T0 + 5 * SECOND);
        assert.deepEqual(r.location, at(charger), `${from} -> ${charger}`);
      }
    }
  });

  test("a robot already at the charger is parked at once", () => {
    const r = robot();
    pay(r, "charger-001", T0);
    r.tick(T0 + 14 * SECOND);
    r.tick(T0 + 15 * SECOND); // session over; it is standing on the charger node
    r.seekCharge();
    pay(r, "charger-001", T0 + 15 * SECOND);
    assert.equal(r.snapshot().motion.mode, "parked");
  });

  test("a charger that is not in the graph: it drives to the nearest intersection, then the last few metres", () => {
    const elsewhere = { lat: 30.2666, lng: -97.7412 }; // just off Brazos St & 4th St
    const r = robot();
    r.startCharging({ deviceId: "charger-099", location: elsewhere, minutes: 15, expiresAt: expiresIn(15, T0), now: T0 });
    const nodes = r.plan.slice(0, -1).map((p) => p.node);
    nodes.slice(1).forEach((id, i) => assert.ok(isEdge(nodes[i], id)));
    assert.equal(NODES[nodes.at(-1)].kind, "intersection");
    assert.ok(metersBetween(NODES[nodes.at(-1)], elsewhere) < ONE_BLOCK);
    r.tick(T0 + 5 * SECOND);
    assert.deepEqual(r.location, elsewhere);
  });

  test("one long gap between ticks still ends parked and fully charged", () => {
    const { r, start } = paid();
    const atPayment = r.batteryPct;
    r.tick(start + 15 * SECOND); // a single tick covering the drive and the whole session
    assert.deepEqual(r.location, at("charger-003"));
    assert.equal(r.batteryPct, atPayment + 30);
  });
});

describe("what the dashboard is told", () => {
  test("a delivering robot reports its speed and the street route ahead", () => {
    const r = robot();
    r.tick(T0 + 1 * SECOND);
    const { motion, location } = r.snapshot();
    assert.equal(motion.mode, "delivering");
    assert.equal(motion.speedMps, 100);
    const ahead = [location, ...motion.path];
    let meters = 0;
    for (let i = 0; i + 1 < ahead.length; i++) {
      const step = metersBetween(ahead[i], ahead[i + 1]);
      assert.ok(step <= ONE_BLOCK, `step ${i} is ${Math.round(step)} m`);
      meters += step;
    }
    assert.ok(meters >= 2500, `it can see ${Math.round(meters)} m ahead, enough to keep the dot moving between reports`);
  });

  test("the delivery loop it sends for drawing follows the streets and closes", () => {
    const { route } = robot().snapshot();
    assert.deepEqual(route, deliveryLoopNodes().map((id) => [NODES[id].lat, NODES[id].lng]));
    assert.deepEqual(route[0], route.at(-1));
    for (let i = 0; i + 1 < route.length; i++) {
      assert.ok(metersBetween({ lat: route[i][0], lng: route[i][1] }, { lat: route[i + 1][0], lng: route[i + 1][1] }) <= ONE_BLOCK);
    }
  });

  test("moveToward stops exactly on the target and reports how far it went", () => {
    const a = at("congress-ave-and-6th-st");
    const b = at("brazos-st-and-e-6th-st");
    const partway = moveToward(a, b, 40);
    assert.equal(partway.arrived, false);
    assert.ok(Math.abs(metersBetween(a, partway.location) - 40) < 0.5);
    const all = moveToward(a, b, 10_000);
    assert.deepEqual([all.arrived, all.location], [true, b]);
    assert.ok(Math.abs(all.moved - metersBetween(a, b)) < 0.5);
  });
});
