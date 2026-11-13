// The robot's voice and the operator's voice commands, both through ElevenLabs:
//   Text-to-Speech  - the robot says its key decisions out loud on the dashboard
//   Speech-to-Text  - the operator speaks a command; the server transcribes it
// ELEVENLABS_API_KEY is used only here, on the server. The browser gets audio and
// transcripts, never the key. Without a key everything else keeps working and the
// spoken lines are shown as text only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import express from "express";
import { requireLocal, requireToken } from "./auth.js";
import { config } from "./config.js";
import { getDevice } from "./devices.js";
import { emit, subscribe } from "./events.js";
import { getRobot, lastPayment, pendingApprovals, resolveApproval, setPaused } from "./state.js";
import { executeVoiceCommand, parseVoiceCommand } from "./voice-commands.js";
import { approvalLine, lowBatteryLine, paidLine, planLine, refusedLine, statusLine } from "./voice-lines.js";

const elevenlabs = config.elevenLabsApiKey ? new ElevenLabsClient({ apiKey: config.elevenLabsApiKey, maxRetries: 1, timeoutInSeconds: 20 }) : null;

// A steady, even delivery reads as "machine" without being hard to understand.
const VOICE_SETTINGS = { stability: 0.8, similarityBoost: 0.75, style: 0, speed: 1.0 };

// --- Text-to-Speech, cached by text hash -------------------------------------------------------
// The same line is only ever generated (and billed) once: audio is kept in memory and on
// disk under .cache/voice/, keyed by a hash of the voice, the model, the settings and the text.

const cacheDir = fileURLToPath(new URL("../.cache/voice/", import.meta.url));
const audioCache = new Map(); // hash -> Buffer (mp3)

const hashOf = (text) =>
  createHash("sha256").update(JSON.stringify([config.voiceId, config.ttsModel, VOICE_SETTINGS, text])).digest("hex").slice(0, 32);

/** Returns { hash, cached } once audio for `text` exists, generating it if needed. */
async function synthesize(text) {
  const hash = hashOf(text);
  const file = `${cacheDir}${hash}.mp3`;
  if (!audioCache.has(hash) && existsSync(file)) audioCache.set(hash, readFileSync(file));
  if (audioCache.has(hash)) {
    console.log(`[VOICE] cache hit  "${text}" (no ElevenLabs call)`);
    return { hash, cached: true };
  }

  const started = Date.now();
  const stream = await elevenlabs.textToSpeech.convert(config.voiceId, {
    text,
    modelId: config.ttsModel,
    outputFormat: "mp3_44100_128",
    voiceSettings: VOICE_SETTINGS,
  });
  const audio = Buffer.from(await new Response(stream).arrayBuffer());
  audioCache.set(hash, audio);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, audio);
  console.log(`[VOICE] tts call   "${text}" -> ${(audio.length / 1024).toFixed(0)} KB in ${Date.now() - started} ms (${config.ttsModel})`);
  return { hash, cached: false };
}

// Lines are spoken one at a time, in the order they were raised.
let speechQueue = Promise.resolve();

/** Say a line on the dashboard. `kind` names the moment (low_battery, plan, ...). */
export function say(kind, text) {
  speechQueue = speechQueue.then(async () => {
    let audioUrl = null;
    let cached = false;
    if (elevenlabs) {
      try {
        const result = await synthesize(text);
        audioUrl = `/voice/audio/${result.hash}.mp3`;
        cached = result.cached;
      } catch (error) {
        console.warn(`[VOICE] tts failed for "${text}": ${error.statusCode ?? ""} ${error.message}`);
      }
    }
    emit("robot_speech", { kind, text, audioUrl, cached });
  });
  return speechQueue;
}

// --- When the robot speaks --------------------------------------------------------------------
// Five moments only: low battery, plan, approval needed, paid, refused.

const recentlySaid = new Map(); // key -> time, so a retrying agent doesn't repeat itself
function notRecently(key, quietMs) {
  const last = recentlySaid.get(key) ?? 0;
  if (Date.now() - last < quietMs) return false;
  recentlySaid.set(key, Date.now());
  return true;
}

const discovered = new Map(); // cycleId -> chargers seen in DISCOVER (with distances)
const announcedPayments = new Set(); // tx signatures already spoken
const awaitingChainConfirmation = new Map(); // tx signature -> fallback timer

function announcePayment(txSignature, confirmedOnChain) {
  if (announcedPayments.has(txSignature)) return;
  announcedPayments.add(txSignature);
  clearTimeout(awaitingChainConfirmation.get(txSignature));
  awaitingChainConfirmation.delete(txSignature);
  recentlySaid.delete("low_battery"); // a new low-battery episode may be announced after this charge
  say("paid", paidLine({ confirmedOnChain }));
}

subscribe((event) => {
  if (event.type === "agent_event") {
    const { phase, data = {}, robot } = event;

    if (phase === "DECIDE" && data.chargeNeeded && robot && notRecently("low_battery", 90_000)) {
      say("low_battery", lowBatteryLine({ batteryPct: robot.batteryPct }));
    }
    if (phase === "DISCOVER" && data.chargers) {
      discovered.set(data.cycleId, data.chargers);
      if (discovered.size > 20) discovered.delete(discovered.keys().next().value);
    }
    if (phase === "PLAN" && data.planner && notRecently(`plan:${data.deviceId}:${data.minutes}`, 30_000)) {
      const idle = (discovered.get(data.cycleId) ?? []).filter((c) => c.status === "idle");
      const nearest = idle.reduce((best, c) => (!best || c.distanceKm < best.distanceKm ? c : best), null);
      say(
        "plan",
        planLine({
          chargerName: getDevice(data.deviceId)?.name ?? data.deviceId,
          isClosest: nearest?.id === data.deviceId,
          minutes: data.minutes,
          amount: config.pricePer15MinBaseUnits * (data.minutes / 15),
        }),
      );
    }
    if (phase === "REFUSED") {
      const line = refusedLine({ reason: data.reasons?.[0] ?? event.message });
      if (notRecently(`refused:${line}`, 120_000)) say("refused", line);
    }
  }

  if (event.type === "approval_requested") say("approval", approvalLine());

  // "Paid + confirmed": speak once an on-chain check has seen the payment. The server's own
  // RPC check usually has by now; otherwise wait a few seconds for QuickNode Streams.
  if (event.type === "payment_settled") {
    if (event.onChainCheck === "confirmed") announcePayment(event.txSignature, true);
    else awaitingChainConfirmation.set(event.txSignature, setTimeout(() => announcePayment(event.txSignature, false), 8000));
  }
  if (event.type === "onchain_confirmed" && event.matched) announcePayment(event.txSignature, true);
});

// --- Routes -----------------------------------------------------------------------------------

export const voice = express.Router();

// Audio for a line the server has already generated. Only existing hashes are served, so
// this route can never be used to make new (billable) speech.
voice.get("/voice/audio/:file", (req, res) => {
  const hash = req.params.file.replace(/\.mp3$/, "");
  if (!/^[0-9a-f]{32}$/.test(hash)) return res.status(404).json({ error: "unknown audio" });
  if (!audioCache.has(hash) && existsSync(`${cacheDir}${hash}.mp3`)) audioCache.set(hash, readFileSync(`${cacheDir}${hash}.mp3`)); // kept from an earlier run
  const audio = audioCache.get(hash);
  if (!audio) return res.status(404).json({ error: "unknown audio" });
  res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" }).send(audio);
});

// Push-to-talk: the dashboard posts a short recording, the server transcribes it with
// ElevenLabs Speech-to-Text and matches it against the five allowed commands.
// Localhost only, and it needs the same token as the dashboard's buttons.
voice.post("/voice/command", requireLocal, requireToken, express.raw({ type: () => true, limit: "5mb" }), async (req, res) => {
  if (!elevenlabs) return res.status(503).json({ error: "voice is disabled: ELEVENLABS_API_KEY is not set" });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
    console.warn(`[VOICE] command rejected: no usable audio (${Buffer.isBuffer(req.body) ? req.body.length : 0} bytes)`);
    return res.status(400).json({ error: "no audio received" });
  }

  let transcript;
  try {
    const started = Date.now();
    const result = await elevenlabs.speechToText.convert({
      file: new Blob([req.body], { type: req.get("content-type") ?? "audio/webm" }),
      modelId: config.sttModel,
      languageCode: "en",
      tagAudioEvents: false,
    });
    transcript = (result.text ?? "").trim();
    console.log(`[VOICE] stt call   ${(req.body.length / 1024).toFixed(0)} KB -> "${transcript}" in ${Date.now() - started} ms (${config.sttModel})`);
  } catch (error) {
    console.warn(`[VOICE] stt failed: ${error.statusCode ?? ""} ${error.message}`);
    return res.status(502).json({ error: "transcription failed" });
  }

  const { command, reason } = parseVoiceCommand(transcript);
  // Everything a spoken command is able to touch. Nothing about limits, recipients or amounts.
  const result = executeVoiceCommand(command, {
    pendingApprovals,
    resolveApproval: (id, decision) => resolveApproval(id, decision, "voice"),
    setPaused,
    status: () => {
      const payment = lastPayment();
      return statusLine({ robot: getRobot(), lastPayment: payment, chargerName: payment && getDevice(payment.deviceId)?.name });
    },
  });
  const outcome = command ? result.outcome : reason;
  emit("voice_command", { transcript, command, done: result.done, outcome });
  if (result.say) say("reply", result.say);
  res.json({ transcript, command, done: result.done, outcome });
});
