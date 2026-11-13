// A simulated delivery robot: a battery that drains while it works and
// rises while a paid charging session is active.

const EARTH_RADIUS_KM = 6371;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Straight-line (haversine) distance between two { lat, lng } points, in km. */
export function distanceKm(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export class Robot {
  constructor({ id, location, startBatteryPct, drainPctPerSecond, chargePctPerMinute, now = Date.now() }) {
    this.id = id;
    this.location = { ...location };
    this.batteryPct = startBatteryPct;
    this.status = "delivering"; // delivering | seeking_charge | charging | idle
    this.drainPctPerSecond = drainPctPerSecond;
    this.chargePctPerMinute = chargePctPerMinute;
    this.session = null;
    this.lastTick = now;
  }

  /** Battery % a session of this many paid minutes would add. */
  gainFor(minutes) {
    return minutes * this.chargePctPerMinute;
  }

  /** Advance the simulation to `now`. Call this before reading the battery. */
  tick(now = Date.now()) {
    const elapsedSeconds = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;

    if (this.status === "charging") {
      const { startedAt, endsAt, fromPct, gainPct } = this.session;
      const progress = Math.min(1, (now - startedAt) / (endsAt - startedAt));
      this.batteryPct = Math.min(100, fromPct + gainPct * progress);
      if (progress >= 1) {
        this.session = null;
        this.status = "delivering"; // charged: back to work
      }
    } else if (this.status !== "idle") {
      this.batteryPct = Math.max(0, this.batteryPct - this.drainPctPerSecond * elapsedSeconds);
      if (this.batteryPct === 0) this.status = "idle"; // flat battery: stranded
    }
  }

  seekCharge() {
    if (this.status === "delivering") this.status = "seeking_charge";
  }

  /**
   * Plug in at a charger. The server's expiresAt decides how long power flows;
   * the paid minutes decide how much battery that adds.
   */
  startCharging({ deviceId, location, minutes, expiresAt, now = Date.now() }) {
    this.location = { ...location };
    this.session = {
      deviceId,
      startedAt: now,
      endsAt: Math.max(now + 1, Date.parse(expiresAt)),
      fromPct: this.batteryPct,
      gainPct: this.gainFor(minutes),
    };
    this.status = "charging";
    this.lastTick = now;
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      batteryPct: Math.floor(this.batteryPct), // round down: 19.9% reads as 19%, never as a healthy 20%
      location: { ...this.location },
    };
  }
}
