// In-memory state behind the dashboard: the robot's latest report, the payment list
// with its two confirmations, pending approvals, and the kill switch.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config, explorerUrl } from "./config.js";
import { markSessionConfirmed } from "./devices.js";
import { emit } from "./events.js";

// --- Robot (latest state reported by the agent) ------------------------------------------

let robot = null;

export const getRobot = () => robot;

export function updateRobot(reported) {
  if (reported && typeof reported === "object") robot = { ...reported, lastSeen: new Date().toISOString() };
}

// --- Payments ------------------------------------------------------------------------------
// Each payment can be confirmed twice, by two independent sources:
//   facilitatorSettled - the x402 facilitator reported the transaction as settled
//   streamsConfirmed   - QuickNode Streams delivered the same transaction from the chain

const payments = []; // newest first
const streamSightings = new Map(); // tx signature -> Streams match (may arrive before or after the payment)
const PAYMENT_LIMIT = 50;

export function recordPayment({ txSignature, deviceId, sessionId, minutes, amount, payer, onChainCheck }) {
  const payment = {
    txSignature,
    deviceId,
    sessionId,
    minutes,
    amount,
    payer,
    time: new Date().toISOString(),
    explorerUrl: explorerUrl(txSignature),
    facilitatorSettled: true,
    rpcCheck: onChainCheck,
    streamsConfirmed: false,
    streams: null,
  };
  payments.unshift(payment);
  if (payments.length > PAYMENT_LIMIT) payments.pop();

  const sighting = streamSightings.get(txSignature);
  if (sighting) confirmByStreams(sighting); // Streams got here first
  return payment;
}

/**
 * A transaction paying USDC to the merchant arrived from QuickNode Streams.
 * Marks the matching payment (if any) as confirmed and tells the dashboard.
 */
export function confirmByStreams(match) {
  streamSightings.set(match.signature, match);
  const payment = payments.find((p) => p.txSignature === match.signature);

  // The on-chain amount must cover what the session cost.
  const amountOk = payment ? Math.round(match.amountUSDC * 1e6) >= Number(payment.amount) : false;
  if (payment && amountOk && !payment.streamsConfirmed) {
    payment.streamsConfirmed = true;
    payment.streams = { slot: match.slot, blockTime: match.blockTime, from: match.from, to: match.to, amountUSDC: match.amountUSDC };
    markSessionConfirmed(payment.deviceId, payment.sessionId);
  }
  emit("onchain_confirmed", {
    txSignature: match.signature,
    slot: match.slot,
    blockTime: match.blockTime,
    from: match.from,
    to: match.to,
    amountUSDC: match.amountUSDC,
    matched: Boolean(payment && amountOk),
    deviceId: payment?.deviceId ?? null,
    sessionId: payment?.sessionId ?? null,
  });
}

export const lastPayment = () => payments[0] ?? null;
export const pendingApprovals = () => [...approvals.values()].filter((a) => a.status === "pending");

let lastStreamsDelivery = null;
export const noteStreamsDelivery = () => (lastStreamsDelivery = new Date().toISOString());

// --- Approvals (human sign-off for payments above the agent's threshold) -------------------

const approvals = new Map(); // id -> { id, status: "pending" | "approved" | "denied", by, ... }

export function createApproval({ id, deviceId, minutes, amount, payTo, timeoutSeconds = 60 }) {
  const approval = {
    id,
    deviceId,
    minutes,
    amount,
    payTo,
    status: "pending",
    by: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
  };
  approvals.set(id, approval);
  emit("approval_requested", { approvalId: id, deviceId, minutes, amount, payTo, expiresAt: approval.expiresAt });
  // No answer in time means no.
  setTimeout(() => resolveApproval(id, "deny", "timeout"), timeoutSeconds * 1000).unref();
  return approval;
}

export const getApproval = (id) => approvals.get(id);

/** First answer wins. Returns { approval, changed }. */
export function resolveApproval(id, decision, by) {
  const approval = approvals.get(id);
  if (!approval) return { approval: null, changed: false };
  if (approval.status !== "pending") return { approval, changed: false };
  approval.status = decision === "approve" ? "approved" : "denied";
  approval.by = by;
  emit("approval_resolved", { approvalId: id, decision: approval.status, by });
  return { approval, changed: true };
}

// --- Kill switch -----------------------------------------------------------------------------
// The agent refuses to pay while the file agent/PAUSED exists. The dashboard button
// creates or removes that file through an authenticated endpoint.

const pauseFile = fileURLToPath(new URL("../agent/PAUSED", import.meta.url));

export const isPaused = () => existsSync(pauseFile);

export function setPaused(paused) {
  if (paused) writeFileSync(pauseFile, `paused from the dashboard at ${new Date().toISOString()}\n`);
  else rmSync(pauseFile, { force: true });
  emit("agent_paused", { paused });
  return paused;
}

// --- Snapshot for GET /state ---------------------------------------------------------------

export function snapshot(devices) {
  return {
    serverTime: new Date().toISOString(),
    network: config.network,
    merchantWallet: config.merchantWallet,
    usdcMint: config.usdcMint,
    robot,
    devices,
    payments,
    pendingApprovals: pendingApprovals(),
    paused: isPaused(),
    streams: { configured: Boolean(config.streamsToken), lastDelivery: lastStreamsDelivery },
    voice: { enabled: Boolean(config.elevenLabsApiKey), ttsModel: config.ttsModel, sttModel: config.sttModel },
  };
}
