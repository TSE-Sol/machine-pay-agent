// Machine Pay Agent - x402 charger server (simulated pay-to-power stations).
import { fileURLToPath } from "node:url";
import express from "express";
import { ALLOWED_MINUTES, assertConfig, config, explorerUrl } from "./config.js";
import { control, streamsWebhook } from "./control.js";
import { chargeRefusal, deviceStatus, getDevice, holdForQuote, listDevices, noteDiscovery, release, reserve, startCharging, startOccupancy } from "./devices.js";
import { sseHandler } from "./events.js";
import { getRobot, recordPayment } from "./state.js";
import { voice } from "./voice.js";
import { checkPayment, initPayments } from "./x402.js";

assertConfig();

const app = express();
app.use(streamsWebhook); // before express.json: signature checks need the raw body
app.use(express.json());
app.use(control);
app.use(voice);
// Dashboard at GET /. "no-cache" makes the browser re-check each file, so an update shows up on reload.
app.use(express.static(fileURLToPath(new URL("../dashboard", import.meta.url)), { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Discovery. A robot looking for power may say where it is (?lat=..&lng=..).
app.get("/devices", (req, res) => {
  if (req.query.lat !== undefined) noteDiscovery({ lat: Number(req.query.lat), lng: Number(req.query.lng) });
  res.json(listDevices());
});

app.get("/devices/:id/status", (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device_not_found" });
  res.json(deviceStatus(device));
});

app.post("/devices/:id/charge", async (req, res) => {
  const device = getDevice(req.params.id);
  if (!device) return res.status(404).json({ error: "device_not_found" });

  const minutes = req.body?.minutes;
  if (!ALLOWED_MINUTES.includes(minutes)) {
    return res.status(400).json({ error: "invalid_minutes", allowed: ALLOWED_MINUTES });
  }

  // Never ask anyone to pay for a charger that is in use: a clear 409, not a 402.
  const busy = () => {
    const refusal = chargeRefusal(device) ?? { status: 409, body: { error: "charger_in_use", message: "charger in use", ...deviceStatus(device) } };
    return res.status(refusal.status).json(refusal.body);
  };
  if (chargeRefusal(device)) return busy();

  const payment = await checkPayment(req, { deviceId: device.id, minutes });
  if (!payment.paid) {
    if (payment.status === 402) holdForQuote(device); // quoted: other robots leave it alone while this one pays
    return res.status(payment.status).set(payment.headers).json(payment.body);
  }

  // Payment is verified but not yet collected. Hold the charger, then settle.
  if (!reserve(device)) return busy();
  const settled = await payment.settle();
  if (!settled.ok) {
    release(device);
    return res.status(settled.status).set(settled.headers).json(settled.body);
  }

  const session = startCharging(device, minutes, settled.txSignature, getRobot()?.id ?? null);
  recordPayment({
    txSignature: settled.txSignature,
    deviceId: device.id,
    sessionId: session.sessionId,
    minutes,
    amount: settled.amount,
    payer: settled.payer,
    onChainCheck: settled.onChainCheck,
  });
  res.set(settled.headers).json({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    minutes: session.minutes,
    expiresAt: session.expiresAt,
    txSignature: session.txSignature,
    explorerUrl: explorerUrl(session.txSignature),
  });
});

app.get("/events", sseHandler);

try {
  await initPayments();
} catch (error) {
  console.error(`Could not reach the x402 facilitator at ${config.facilitatorUrl}: ${error.message}`);
  process.exit(1);
}

startOccupancy();

app.listen(config.port, () => {
  console.log(`Charger server and dashboard on http://localhost:${config.port}`);
  console.log(`  network      ${config.network} (Solana devnet)`);
  console.log(`  merchant     ${config.merchantWallet}`);
  console.log(`  price        ${config.pricePer15MinUsdc.toFixed(2)} USDC per 15 min`);
  console.log(`  facilitator  ${config.facilitatorUrl}`);
  console.log(`  agent token  ${config.agentEventsToken ? "set" : "NOT SET (agent events, approvals and kill switch are disabled)"}`);
  console.log(`  streams      ${config.streamsToken ? "security token set" : "QUICKNODE_STREAMS_TOKEN not set (webhooks are rejected)"}`);
  console.log(`  occupancy    ${{ off: "off (chargers are always free)", random: "random (other robots come and go)", demo: "demo (the nearest charger is busy on the first charge)" }[config.chargerOccupancy]}`);
  console.log(`  voice        ${config.elevenLabsApiKey ? `ElevenLabs on (tts ${config.ttsModel}, stt ${config.sttModel})` : "off (ELEVENLABS_API_KEY not set)"}`);
});
