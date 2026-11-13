// Machine Pay Agent - x402 charger server (simulated pay-to-power stations).
import express from "express";
import { ALLOWED_MINUTES, assertConfig, config, explorerUrl } from "./config.js";
import { deviceStatus, getDevice, isBusy, listDevices, release, reserve, startCharging } from "./devices.js";
import { sseHandler } from "./events.js";
import { checkPayment, initPayments } from "./x402.js";

assertConfig();

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/devices", (req, res) => {
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

  // Don't ask anyone to pay for a charger that's already in use.
  const busy = () => res.status(409).json({ error: "device_busy", ...deviceStatus(device) });
  if (isBusy(device)) return busy();

  const payment = await checkPayment(req, { deviceId: device.id, minutes });
  if (!payment.paid) {
    return res.status(payment.status).set(payment.headers).json(payment.body);
  }

  // Payment is verified but not yet collected. Hold the charger, then settle.
  if (!reserve(device)) return busy();
  const settled = await payment.settle();
  if (!settled.ok) {
    release(device);
    return res.status(settled.status).set(settled.headers).json(settled.body);
  }

  const session = startCharging(device, minutes, settled.txSignature);
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

app.listen(config.port, () => {
  console.log(`Charger server listening on http://localhost:${config.port}`);
  console.log(`  network      ${config.network} (Solana devnet)`);
  console.log(`  merchant     ${config.merchantWallet}`);
  console.log(`  price        ${config.pricePer15MinUsdc.toFixed(2)} USDC per 15 min`);
  console.log(`  facilitator  ${config.facilitatorUrl}`);
});
