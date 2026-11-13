// Control plane: the routes behind the dashboard.
//   - the agent posts its phase events here, and they are rebroadcast on /events
//   - approvals for payments above the agent's threshold (answered from the dashboard)
//   - the kill switch
//   - the QuickNode Streams webhook
// Everything that changes something needs AGENT_EVENTS_TOKEN, except the Streams
// webhook, which is authenticated by QuickNode's signature instead.
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { allDevices, deviceStatus } from "./devices.js";
import { emit } from "./events.js";
import {
  confirmByStreams,
  createApproval,
  getApproval,
  noteStreamsDelivery,
  resolveApproval,
  setPaused,
  snapshot,
  updateRobot,
} from "./state.js";
import { extractMatches, verifyStreamsRequest } from "./streams.js";

const sameSecret = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Require "Authorization: Bearer <AGENT_EVENTS_TOKEN>". */
function requireToken(req, res, next) {
  if (!config.agentEventsToken) return res.status(503).json({ error: "AGENT_EVENTS_TOKEN is not set on the server" });
  const given = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !sameSecret(given, config.agentEventsToken)) return res.status(401).json({ error: "invalid_token" });
  next();
}

/**
 * True only for a browser on this machine talking to localhost directly.
 * Requests that arrive through the public tunnel carry forwarding headers and a public Host.
 */
function isLocalRequest(req) {
  const address = req.socket.remoteAddress ?? "";
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  const forwarded = req.get("x-forwarded-for") || req.get("cf-connecting-ip") || req.get("forwarded");
  return loopback && !forwarded && ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname);
}

// --- QuickNode Streams webhook (mounted before express.json: it needs the raw body) ---------

export const streamsWebhook = express.Router();

streamsWebhook.post("/streams/webhook", express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
  // express.raw has already un-gzipped the body, which is the text QuickNode signed.
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const verdict = verifyStreamsRequest({
    token: config.streamsToken,
    headers: req.headers,
    body,
    maxAgeSeconds: config.streamsMaxAgeSeconds,
  });
  if (!verdict.ok) {
    // Log header names only (never values) so a rejected delivery can be diagnosed.
    const seen = Object.keys(req.headers).filter((name) => name.startsWith("x-qn") || name === "content-encoding" || name === "user-agent");
    console.warn(`[STREAMS] webhook rejected: ${verdict.reason} | ${body.length} bytes | headers present: ${seen.join(", ") || "none of interest"}`);
    return res.status(verdict.status).json({ error: verdict.reason });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return res.status(400).json({ error: "body is not JSON" });
  }
  noteStreamsDelivery();
  const matches = extractMatches(payload);
  for (const match of matches) confirmByStreams(match);
  res.json({ ok: true, matches: matches.length });
});

// --- Dashboard + agent routes ------------------------------------------------------------------

export const control = express.Router();

control.get("/state", (req, res) => {
  res.json(snapshot(allDevices().map((d) => ({ ...deviceStatus(d), location: d.location, type: d.type, pricePer15MinUSDC: config.pricePer15MinUsdc }))));
});

// The dashboard's controls need the token. A browser on this machine gets it here;
// anyone viewing through the public tunnel does not, so their dashboard is read-only.
control.get("/dashboard/session", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: "controls are only available on localhost" });
  if (!config.agentEventsToken) return res.status(503).json({ error: "AGENT_EVENTS_TOKEN is not set on the server" });
  res.set("Cache-Control", "no-store").json({ token: config.agentEventsToken });
});

// Agent -> server: one phase event plus the robot's current state.
control.post("/agent/events", requireToken, (req, res) => {
  const { phase, message, data, robot } = req.body ?? {};
  if (typeof phase !== "string" || typeof message !== "string") return res.status(400).json({ error: "phase and message are required" });
  updateRobot(robot);
  emit("agent_event", { phase, message, data: data ?? {}, robot: robot ?? null });
  res.json({ ok: true });
});

// Agent -> server: "a human needs to approve this payment".
control.post("/agent/approvals", requireToken, (req, res) => {
  const { id, deviceId, minutes, amount, payTo, timeoutSeconds } = req.body ?? {};
  if (typeof id !== "string" || !id) return res.status(400).json({ error: "id is required" });
  if (getApproval(id)) return res.status(409).json({ error: "approval already exists" });
  res.status(201).json(createApproval({ id, deviceId, minutes, amount, payTo, timeoutSeconds }));
});

control.get("/agent/approvals/:id", requireToken, (req, res) => {
  const approval = getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: "approval_not_found" });
  res.json(approval);
});

// Dashboard (or the agent, relaying a terminal answer) -> server: approve or deny. First answer wins.
control.post("/agent/approvals/:id", requireToken, (req, res) => {
  const { decision, by } = req.body ?? {};
  if (!["approve", "deny"].includes(decision)) return res.status(400).json({ error: 'decision must be "approve" or "deny"' });
  const source = ["terminal", "timeout"].includes(by) ? by : "dashboard";
  const { approval, changed } = resolveApproval(req.params.id, decision, source);
  if (!approval) return res.status(404).json({ error: "approval_not_found" });
  res.status(changed ? 200 : 409).json(approval);
});

// Kill switch.
control.post("/agent/pause", requireToken, (req, res) => {
  if (typeof req.body?.paused !== "boolean") return res.status(400).json({ error: "paused must be true or false" });
  res.json({ paused: setPaused(req.body.paused) });
});
