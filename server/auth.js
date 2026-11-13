// Who may use the control routes (approvals, kill switch, voice commands, agent events).
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const sameSecret = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Require "Authorization: Bearer <AGENT_EVENTS_TOKEN>". */
export function requireToken(req, res, next) {
  if (!config.agentEventsToken) return res.status(503).json({ error: "AGENT_EVENTS_TOKEN is not set on the server" });
  const given = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !sameSecret(given, config.agentEventsToken)) return res.status(401).json({ error: "invalid_token" });
  next();
}

/**
 * True only for a browser on this machine talking to localhost directly.
 * Requests that arrive through the public tunnel carry forwarding headers and a public Host.
 */
export function isLocalRequest(req) {
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const forwarded = req.get("x-forwarded-for") || req.get("cf-connecting-ip") || req.get("forwarded");
  return loopback && !forwarded && ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname);
}

export function requireLocal(req, res, next) {
  if (!isLocalRequest(req)) return res.status(403).json({ error: "this control is only available on localhost" });
  next();
}
