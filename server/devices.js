// Simulated pay-to-power charging stations. State lives in memory.
//
// A charger is in one of three states:
//   idle     - free
//   in_use   - another (simulated) robot is using it; see occupancy.js
//   charging - a session this server was paid for is running
import { randomUUID } from "node:crypto";
import { NODES, metersBetween, nearestNode, shortestPath } from "../agent/streets.js";
import { config } from "./config.js";
import { emit } from "./events.js";
import { OCCUPANCY, demoOpening, pickOccupancies, seededRandom } from "./occupancy.js";

const devices = new Map(
  [
    // Austin, Texas
    { id: "charger-001", name: "Congress Ave Robot Dock", location: { lat: 30.2682, lng: -97.7429 } },
    { id: "charger-002", name: "South Congress Charging Bay", location: { lat: 30.2497, lng: -97.7494 } },
    { id: "charger-003", name: "East 6th St Dock", location: { lat: 30.2647, lng: -97.731 } },
  ].map((seed) => [
    seed.id,
    { ...seed, type: "pay-to-power", status: "idle", session: null, reserved: false, timer: null, occupiedUntil: null, heldUntil: 0 },
  ]),
);

export function getDevice(id) {
  return devices.get(id);
}

export const allDevices = () => [...devices.values()];

const minuteMs = () => config.secondsPerMinute * 1000; // one simulated minute, in real milliseconds

/** When the charger will be free again (ISO time), or null if it is idle. */
export function freeAt(device) {
  if (device.status === "in_use") return device.occupiedUntil;
  if (device.status === "charging") return device.session?.expiresAt ?? null;
  return null;
}

/** Simulated minutes until the charger is free (0 when idle). */
export function minutesUntilFree(device) {
  const at = freeAt(device);
  return at ? Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / minuteMs())) : 0;
}

/** "idle", "in_use", or "charging_<robot id>" for a paid session (e.g. "charging_robot-01"). */
export function occupancyStatus(device) {
  if (device.status === "charging") return `charging_${device.session?.robotId ?? "robot"}`;
  return device.status;
}

/** Discovery view of every charger (GET /devices). */
export function listDevices() {
  return [...devices.values()].map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    location: d.location,
    pricePer15MinUSDC: config.pricePer15MinUsdc,
    status: occupancyStatus(d),
    minutesUntilFree: minutesUntilFree(d),
    freeAt: freeAt(d),
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
    occupancy: occupancyStatus(device),
    minutesUntilFree: minutesUntilFree(device),
    freeAt: freeAt(device),
    sessionId: session?.sessionId ?? null,
    expiresAt: session?.expiresAt ?? null,
    secondsRemaining,
    txSignature: session?.txSignature ?? null,
    confirmedByStreams: session?.confirmedByStreams ?? false,
  };
}

export function isBusy(device) {
  return device.status !== "idle" || device.reserved;
}

/**
 * The answer to a charge request for a charger that cannot take it: HTTP 409 "charger in use".
 * Returns null when the charger is free. This is checked before any 402 is issued, so nobody
 * is ever asked to pay for a busy dock.
 */
export function chargeRefusal(device) {
  if (!isBusy(device)) return null;
  return { status: 409, body: { error: "charger_in_use", message: "charger in use", ...deviceStatus(device) } };
}

// A robot that was just quoted a price gets a short head start: other robots do not take the
// charger while it decides and pays (a 402 is good for about a minute).
const QUOTE_HOLD_MS = 90_000;

export function holdForQuote(device) {
  device.heldUntil = Date.now() + QUOTE_HOLD_MS;
}

// --- Other robots (simulated occupancy) ------------------------------------------------------

/** Another robot takes this charger for a number of simulated minutes. */
export function occupy(device, minutes) {
  if (isBusy(device)) return false;
  const durationMs = minutes * minuteMs();
  device.status = "in_use";
  device.occupiedUntil = new Date(Date.now() + durationMs).toISOString();
  device.timer = setTimeout(() => vacate(device), durationMs);
  device.timer.unref();
  emit("charger_occupied", { deviceId: device.id, minutes, freeAt: device.occupiedUntil });
  return true;
}

/** The other robot leaves. */
export function vacate(device) {
  if (device.status !== "in_use") return;
  clearTimeout(device.timer);
  device.status = "idle";
  device.occupiedUntil = null;
  device.timer = null;
  emit("charger_freed", { deviceId: device.id });
}

const occupancy = { mode: "off", random: Math.random, opened: false, timer: null };
const openForOthers = (device) => !isBusy(device) && Date.now() >= device.heldUntil;

/**
 * One occupancy check: each idle charger may be taken by another robot. A charger held for a
 * robot that was just quoted is left alone, and at least one charger always stays idle.
 */
export function occupancyCheck() {
  if (occupancy.mode === "off") return;
  if (occupancy.mode === "demo" && !occupancy.opened) return; // the demo starts with every charger free
  const chargers = allDevices().map((device) => ({ id: device.id, idle: openForOthers(device) }));
  for (const { id, minutes } of pickOccupancies(chargers, { random: occupancy.random })) occupy(devices.get(id), minutes);
}

/** Street distance in metres from a point to a charger (the same street map the robot drives on). */
function streetMeters(location, device) {
  const from = nearestNode(location, ["intersection"]);
  const to = NODES[device.id]?.kind === "charger" ? device.id : nearestNode(device.location, ["intersection"]);
  return shortestPath(from, to)?.meters ?? metersBetween(location, device.location);
}

/**
 * A robot at `location` is looking for a charger (GET /devices?lat=..&lng=..).
 * In demo mode the first such request finds the charger nearest to it busy.
 */
export function noteDiscovery(location) {
  if (occupancy.mode !== "demo" || occupancy.opened) return;
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return;
  occupancy.opened = true;
  const chargers = allDevices().map((device) => ({ id: device.id, idle: !isBusy(device), meters: streetMeters(location, device) }));
  const opening = demoOpening(chargers);
  if (opening) occupy(devices.get(opening.id), opening.minutes);
}

/** Start (or change) the occupancy simulation. mode: "off" | "random" | "demo". */
export function startOccupancy(mode = config.chargerOccupancy, { random } = {}) {
  clearInterval(occupancy.timer);
  occupancy.mode = mode;
  occupancy.opened = false;
  occupancy.random = random ?? (mode === "demo" ? seededRandom(OCCUPANCY.demoSeed) : Math.random);
  occupancy.timer = null;
  if (mode === "off") return;
  occupancy.timer = setInterval(occupancyCheck, OCCUPANCY.checkEveryMinutes * minuteMs());
  occupancy.timer.unref();
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
export function startCharging(device, minutes, txSignature, robotId = null) {
  const durationMs = minutes * config.secondsPerMinute * 1000;
  const session = {
    sessionId: randomUUID(),
    deviceId: device.id,
    robotId, // which robot this session is for, when the server knows
    minutes,
    expiresAt: new Date(Date.now() + durationMs).toISOString(),
    txSignature,
    confirmedByStreams: false, // set when QuickNode Streams delivers the payment from the chain
  };
  device.reserved = false;
  device.status = "charging";
  device.session = session;
  device.timer = setTimeout(() => stopCharging(device), durationMs);
  device.timer.unref(); // the HTTP server keeps the process alive, not this timer

  emit("charging_started", { deviceId: device.id, sessionId: session.sessionId, minutes, expiresAt: session.expiresAt });
  return session;
}

/** QuickNode Streams saw this session's payment on-chain. */
export function markSessionConfirmed(deviceId, sessionId) {
  const session = devices.get(deviceId)?.session;
  if (session && session.sessionId === sessionId) session.confirmedByStreams = true;
}

function stopCharging(device) {
  const sessionId = device.session?.sessionId ?? null;
  clearTimeout(device.timer);
  device.status = "idle";
  device.session = null;
  device.timer = null;
  emit("charging_ended", { deviceId: device.id, sessionId });
}
