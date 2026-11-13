// Event bus: every event is logged as one console line and pushed to all
// connected Server-Sent Events clients (GET /events). The dashboard will use this.
import { formatUsdc } from "./config.js";

const clients = new Set();
const recent = []; // replayed to new subscribers so a fresh dashboard isn't empty
const RECENT_LIMIT = 50;
let nextId = 1;

const clock = (isoTime) => new Date(isoTime).toLocaleTimeString("en-GB");

const logLine = {
  payment_required: (e) => `[402] ${e.deviceId} ${e.minutes}min ${formatUsdc(e.amount)} USDC`,
  payment_verified: (e) => `[VERIFIED] ${e.deviceId} payer=${e.payer}`,
  payment_settled: (e) => `[PAID] ${e.deviceId} ${formatUsdc(e.amount)} USDC sig=${e.txSignature}`,
  payment_rejected: (e) => `[REJECTED] ${e.deviceId} reason=${e.reason}`,
  charging_started: (e) => `[ON] ${e.deviceId} until ${clock(e.expiresAt)}`,
  charging_ended: (e) => `[OFF] ${e.deviceId}`,
};

export function emit(type, data) {
  const event = { id: nextId++, type, time: new Date().toISOString(), ...data };
  console.log(logLine[type]?.(event) ?? `[${type}] ${JSON.stringify(data)}`);

  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  for (const res of clients) send(res, event);
  return event;
}

function send(res, event) {
  res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** Express handler for GET /events. */
export function sseHandler(req, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  for (const event of recent) send(res, event);

  clients.add(res);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}
