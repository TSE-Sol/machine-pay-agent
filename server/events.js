// Event bus: every event is logged as one console line and pushed to all
// connected Server-Sent Events clients (GET /events). The dashboard listens here.
import { formatUsdc } from "./config.js";

const clients = new Set();
const listeners = new Set(); // in-process subscribers (the robot's voice reacts to events)
const recent = []; // replayed to new subscribers so a fresh dashboard isn't empty
const RECENT_LIMIT = 200;
let nextId = 1;

const clock = (isoTime) => new Date(isoTime).toLocaleTimeString("en-GB");

const logLine = {
  payment_required: (e) => `[402] ${e.deviceId} ${e.minutes}min ${formatUsdc(e.amount)} USDC`,
  payment_verified: (e) => `[VERIFIED] ${e.deviceId} payer=${e.payer}`,
  payment_settled: (e) => `[PAID] ${e.deviceId} ${formatUsdc(e.amount)} USDC sig=${e.txSignature}`,
  payment_rejected: (e) => `[REJECTED] ${e.deviceId} reason=${e.reason}`,
  charging_started: (e) => `[ON] ${e.deviceId} until ${clock(e.expiresAt)}`,
  charging_ended: (e) => `[OFF] ${e.deviceId}`,
  // Events relayed from the agent. The routine ticks are not echoed to this console.
  agent_event: (e) => (["OBSERVE", "DECIDE", "CHARGING"].includes(e.phase) ? null : `[AGENT] ${e.phase}: ${e.message}`),
  approval_requested: (e) => `[APPROVAL?] ${e.deviceId} ${formatUsdc(e.amount)} USDC (id ${e.approvalId})`,
  approval_resolved: (e) => `[APPROVAL] ${e.decision} by ${e.by} (id ${e.approvalId})`,
  agent_paused: (e) => `[KILL SWITCH] payments ${e.paused ? "PAUSED" : "resumed"}`,
  onchain_confirmed: (e) =>
    `[STREAMS] ${e.amountUSDC} USDC confirmed on-chain sig=${e.txSignature} slot=${e.slot}${e.matched ? ` -> ${e.deviceId}` : " (no matching session)"}`,
  streams_rejected: (e) => `[STREAMS] webhook rejected: ${e.reason}`,
  robot_speech: () => null, // server/voice.js logs its own [VOICE] lines
  voice_command: (e) => `[VOICE] heard "${e.transcript}" -> ${e.command ? e.command.toUpperCase() : "no action"} (${e.outcome})`,
};

export function emit(type, data) {
  const event = { id: nextId++, type, time: new Date().toISOString(), ...data };
  const line = logLine[type] ? logLine[type](event) : `[${type}] ${JSON.stringify(data)}`;
  if (line) console.log(line);

  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  for (const res of clients) send(res, event);
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error(`[events] listener failed: ${error.message}`);
    }
  }
  return event;
}

/** Call `listener(event)` for every event emitted from now on. */
export function subscribe(listener) {
  listeners.add(listener);
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
