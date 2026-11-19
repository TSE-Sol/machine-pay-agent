// A simulated delivery robot. It drives a delivery loop through downtown Austin, its battery
// drains while it works, and once a charging session has been paid for it drives to that
// charger and parks there. Every move follows the street graph in streets.js: from one
// intersection to the next, never across a block.
import { DELIVERY_STOPS, NODES, deliveryLoopNodes, metersBetween, nearestNode, pointsOf, shortestPath } from "./streets.js";

/** Straight-line distance between two { lat, lng } points, in km. (Used to rank chargers by distance.) */
export function distanceKm(a, b) {
  return metersBetween(a, b) / 1000;
}

// A paid session's clock starts at payment, so the robot must not dawdle on the way to the
// charger: it speeds up if needed to arrive within this share of the session.
const ARRIVE_WITHIN_SHARE_OF_SESSION = 0.3;

const point = (p) => ({ lat: p.lat, lng: p.lng });

/**
 * Move from `from` toward `to` by up to `meters`.
 * Returns { location, moved, arrived }: where it ends up, how far it went, and whether it reached `to`.
 */
export function moveToward(from, to, meters) {
  const distance = metersBetween(from, to);
  if (distance <= meters || distance < 0.01) return { location: point(to), moved: distance, arrived: true };
  const share = meters / distance; // within one block a straight blend of lat/lng is exact enough
  return {
    location: { lat: from.lat + (to.lat - from.lat) * share, lng: from.lng + (to.lng - from.lng) * share },
    moved: meters,
    arrived: false,
  };
}

/** Length in metres of the path from `start` through `points`. */
function pathMeters(start, points) {
  let total = 0;
  let here = start;
  for (const next of points) {
    total += metersBetween(here, next);
    here = next;
  }
  return total;
}

export class Robot {
  /**
   * speedMetersPerSecond is the cruising speed in map metres per real second
   * (agent/config.js scales a delivery robot's walking pace by DEMO_SECONDS_PER_MINUTE).
   * drainPctPerKm is what the drive to a charger costs: the battery falls by that much per km
   * on the way there, and the planner uses the same number to tell which chargers are in reach.
   * The robot starts at the intersection nearest `location`.
   */
  constructor({ id, location, startBatteryPct, drainPctPerSecond, drainPctPerKm = 0, chargePctPerMinute, speedMetersPerSecond = 1.67, stops = DELIVERY_STOPS, now = Date.now() }) {
    this.id = id;
    this.batteryPct = startBatteryPct;
    this.status = "delivering"; // delivering | seeking_charge | charging | idle
    this.drainPctPerSecond = drainPctPerSecond;
    this.drainPctPerKm = drainPctPerKm;
    this.chargePctPerMinute = chargePctPerMinute;
    this.speedMetersPerSecond = speedMetersPerSecond;
    this.stops = stops;
    this.loop = deliveryLoopNodes(stops).map((nodeId) => [NODES[nodeId].lat, NODES[nodeId].lng]); // for drawing

    // Where it is on the street graph.
    this.lastNode = nearestNode(location, ["intersection"]); // the last node it stood on
    this.location = point(NODES[this.lastNode]);
    this.plan = []; // the points still ahead on its current trip, in order: [{ lat, lng, node }]
    this.nextStop = this.#nearestStop(this.lastNode);

    this.session = null;
    this.lastTick = now;
  }

  /** Battery % a session of this many paid minutes would add. */
  gainFor(minutes) {
    return minutes * this.chargePctPerMinute;
  }

  /** The delivery stop with the shortest street route from `nodeId`. */
  #nearestStop(nodeId) {
    let best = 0;
    let bestMeters = Infinity;
    this.stops.forEach((stop, index) => {
      const meters = shortestPath(nodeId, stop)?.meters ?? Infinity;
      if (meters < bestMeters) [best, bestMeters] = [index, meters];
    });
    return best;
  }

  /** Delivering with nothing planned: plan the street route to the next delivery stop. */
  #planNextLeg() {
    if (this.lastNode === this.stops[this.nextStop]) this.nextStop = (this.nextStop + 1) % this.stops.length;
    const route = shortestPath(this.lastNode, this.stops[this.nextStop]);
    if (!route) return false;
    // If it is standing off the graph (at a charger that is not a node), it first walks back to its node.
    const backToNode = metersBetween(this.location, NODES[this.lastNode]) > 1 ? [this.lastNode] : [];
    this.plan = pointsOf([...backToNode, ...route.nodes.slice(1)]);
    return this.plan.length > 0;
  }

  /** Drive up to `meters` along the plan, point by point. Returns how far it actually went. */
  #drive(meters, { keepPlanning }) {
    let left = meters;
    while (left > 0.01) {
      if (this.plan.length === 0 && !(keepPlanning && this.#planNextLeg())) break;
      const step = moveToward(this.location, this.plan[0], left);
      this.location = step.location;
      left -= step.moved;
      if (!step.arrived) break;
      const reached = this.plan.shift();
      if (reached.node) this.lastNode = reached.node;
    }
    return meters - left;
  }

  /** Advance the simulation to `now`. Call this before reading the battery or the position. */
  tick(now = Date.now()) {
    const elapsedSeconds = Math.max(0, (now - this.lastTick) / 1000);
    const from = this.lastTick;
    this.lastTick = now;

    if (this.status === "charging") {
      this.#tickCharging(from, now);
    } else if (this.status !== "idle") {
      // Delivering: drive the loop. Seeking a charge: wait where it is until a payment settles.
      if (this.status === "delivering") this.#drive(this.speedMetersPerSecond * elapsedSeconds, { keepPlanning: true });
      this.batteryPct = Math.max(0, this.batteryPct - this.drainPctPerSecond * elapsedSeconds);
      if (this.batteryPct === 0) this.status = "idle"; // flat battery: stranded
    }
  }

  /** A session is paid: drive to the charger along the streets, then sit there and charge until it ends. */
  #tickCharging(from, now) {
    const session = this.session;
    if (session.arrivedAt === null) {
      const moved = this.#drive((session.driveSpeed * (now - from)) / 1000, { keepPlanning: false });
      this.batteryPct = Math.max(0, this.batteryPct - (moved / 1000) * this.drainPctPerKm); // the drive costs battery
      if (this.plan.length > 0) return; // still on the way; it only charges once it is plugged in
      session.arrivedAt = Math.min(now, from + (moved / session.driveSpeed) * 1000);
      session.fromPct = this.batteryPct; // charging starts from what is left on arrival
    }
    const chargingTime = Math.max(1, session.endsAt - session.arrivedAt);
    const progress = Math.min(1, (now - session.arrivedAt) / chargingTime);
    this.batteryPct = Math.min(100, session.fromPct + session.gainPct * progress);
    if (now >= session.endsAt) {
      this.session = null;
      this.status = "delivering"; // charged: back to work,
      this.nextStop = this.#nearestStop(this.lastNode); // heading for the nearest delivery stop
      this.plan = [];
    }
  }

  seekCharge() {
    if (this.status === "delivering") this.status = "seeking_charge";
  }

  /**
   * The street route from where the robot is to a charger, as the points still to drive through:
   * to the intersection at the end of its block, across the grid by the shortest route to the
   * charger's intersection, then to the charger.
   */
  #routeTo(deviceId, location) {
    // The charger's node: its own entry in the graph if it has one here, else the nearest intersection.
    const known = NODES[deviceId]?.kind === "charger" && metersBetween(NODES[deviceId], location) < 30;
    const target = known ? deviceId : nearestNode(location, ["intersection"]);

    // The robot is at a node, or part-way along a block. Leave the block by whichever end
    // makes the shorter trip to the charger.
    const ends = [...new Set([this.lastNode, this.plan[0]?.node].filter(Boolean))];
    let best = null;
    for (const end of ends) {
      const route = shortestPath(end, target);
      if (!route) continue;
      const meters = metersBetween(this.location, NODES[end]) + route.meters;
      if (!best || meters < best.meters) best = { nodes: route.nodes, meters };
    }
    const points = best ? pointsOf(best.nodes).filter((p, i) => i > 0 || metersBetween(this.location, p) > 0.01) : [];
    if (!known) points.push(point(location)); // a charger off the graph: the last few metres from its intersection
    return points;
  }

  /** How far the drive to a charger is along the streets, in km. Planning only: the robot does not move. */
  routeKmTo({ id, location }) {
    return pathMeters(this.location, this.#routeTo(id, location)) / 1000;
  }

  /**
   * A charging session has been paid for and confirmed. The robot now drives to that charger
   * along the streets: from where it is to the intersection at the end of its block, across
   * the grid by the shortest route to the charger's intersection, then to the charger.
   * The server's expiresAt decides when power stops; the paid minutes decide how much battery
   * the session adds.
   * (This is only called after a payment settles. With no settled payment the robot never
   * heads for a charger.)
   */
  startCharging({ deviceId, location, minutes, expiresAt, now = Date.now() }) {
    const endsAt = Math.max(now + 1, Date.parse(expiresAt));
    this.plan = this.#routeTo(deviceId, location);
    const metersToGo = pathMeters(this.location, this.plan);
    const sessionSeconds = (endsAt - now) / 1000;
    this.session = {
      deviceId,
      location: point(location),
      startedAt: now,
      endsAt,
      arrivedAt: this.plan.length === 0 ? now : null, // null while it is still driving there
      driveSpeed: Math.max(this.speedMetersPerSecond, metersToGo / (sessionSeconds * ARRIVE_WITHIN_SHARE_OF_SESSION)),
      fromPct: this.batteryPct,
      gainPct: this.gainFor(minutes),
    };
    this.status = "charging";
    this.lastTick = now;
  }

  /** The road ahead while delivering: the current plan, then the next stops, about 3 km in all. */
  #roadAhead() {
    const ahead = this.plan.map(point);
    let node = this.plan.at(-1)?.node ?? this.lastNode;
    let stop = this.nextStop;
    let meters = pathMeters(this.location, ahead);
    for (let leg = 0; leg < this.stops.length && meters < 3000; leg++) {
      if (node === this.stops[stop]) stop = (stop + 1) % this.stops.length;
      const route = shortestPath(node, this.stops[stop]);
      if (!route) break;
      ahead.push(...pointsOf(route.nodes.slice(1)).map(point));
      meters += route.meters;
      node = this.stops[stop];
    }
    return ahead;
  }

  /** How the robot is moving right now, for the dashboard map. `path` is the street route ahead. */
  #motion() {
    if (this.status === "delivering") return { mode: "delivering", speedMps: this.speedMetersPerSecond, path: this.#roadAhead(), loops: false };
    if (this.status === "charging" && this.session.arrivedAt === null) {
      return { mode: "to_charger", speedMps: this.session.driveSpeed, path: this.plan.map(point), loops: false, deviceId: this.session.deviceId };
    }
    if (this.status === "charging") return { mode: "parked", speedMps: 0, path: [], loops: false, deviceId: this.session.deviceId };
    return { mode: this.status === "idle" ? "stopped" : "holding", speedMps: 0, path: [], loops: false };
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      batteryPct: Math.floor(this.batteryPct), // round down: 19.9% reads as 19%, never as a healthy 20%
      location: { ...this.location },
      motion: this.#motion(),
      route: this.loop, // the delivery loop along the streets, for drawing
    };
  }
}
