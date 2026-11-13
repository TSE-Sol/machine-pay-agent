// Simulated pay-to-power charging stations. State lives in memory.
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { emit } from "./events.js";

const devices = new Map(
  [
    // Austin, Texas
    { id: "charger-001", name: "Congress Ave Robot Dock", location: { lat: 30.2682, lng: -97.7429 } },
    { id: "charger-002", name: "South Congress Charging Bay", location: { lat: 30.2497, lng: -97.7494 } },
    { id: "charger-003", name: "East 6th St Dock", location: { lat: 30.2647, lng: -97.731 } },
  ].map((seed) => [
    seed.id,
    { ...seed, type: "pay-to-power", status: "idle", session: null, reserved: false, timer: null },
  ]),
);

export function getDevice(id) {
  return devices.get(id);
}

/** Discovery view of every charger (GET /devices). */
export function listDevices() {
  return [...devices.values()].map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    location: d.location,
    pricePer15MinUSDC: config.pricePer15MinUsdc,
    status: d.status,
  }));
}

/** Current state and time left (GET /devices/:id/status). */
export function deviceStatus(device) {
  const session = device.session;
  const secondsRemaining = session
    ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000))
    : 0;
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    sessionId: session?.sessionId ?? null,
    expiresAt: session?.expiresAt ?? null,
    secondsRemaining,
  };
}

export function isBusy(device) {
  return device.status === "charging" || device.reserved;
}

/**
 * Hold a charger while its payment settles, so two robots can't both pay for it.
 * Returns false if someone else already holds it.
 */
export function reserve(device) {
  if (isBusy(device)) return false;
  device.reserved = true;
  return true;
}

export function release(device) {
  device.reserved = false;
}

/** Turn the charger on for the paid time; it turns itself off when time runs out. */
export function startCharging(device, minutes, txSignature) {
  const durationMs = minutes * config.secondsPerMinute * 1000;
  const session = {
    sessionId: randomUUID(),
    deviceId: device.id,
    minutes,
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
    txSignature,
  };
  device.reserved = false;
  device.status = "charging";
  device.session = session;
  device.timer = setTimeout(() => stopCharging(device), durationMs);

  emit("charging_started", { deviceId: device.id, sessionId: session.sessionId, minutes, expiresAt: session.expiresAt });
  return session;
}

function stopCharging(device) {
  const sessionId = device.session?.sessionId ?? null;
  clearTimeout(device.timer);
  device.status = "idle";
  device.session = null;
  device.timer = null;
  emit("charging_ended", { deviceId: device.id, sessionId });
}
