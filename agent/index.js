// Entry point: `npm run agent`. Starts the simulated robot and runs the decision loop.
import { existsSync } from "node:fs";
import { requestApproval } from "./approval.js";
import { AuditLog } from "./audit.js";
import { createChargerClient } from "./charger.js";
import { config, formatUsdc } from "./config.js";
import { createControlClient } from "./control.js";
import { spentLast24h } from "./guardrails.js";
import { runCycle } from "./loop.js";
import { Robot } from "./robot.js";
import { loadWallet } from "./wallet.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (config.limits.allowedPayTo.length === 0) {
  console.error("No allowed recipients. Set MERCHANT_WALLET (or ALLOWED_PAY_TO) in .env; the agent only pays allowlisted wallets.");
  process.exit(1);
}

const robot = new Robot(config.robot);
const audit = new AuditLog(config.auditLogPath);
const charger = createChargerClient(config.serverUrl);
const control = createControlClient({ url: config.controlUrl, token: config.eventsToken });
const wallet = await loadWallet({ walletPath: config.walletPath, rpcUrl: config.rpcUrl, limits: config.limits });

try {
  await charger.listDevices();
} catch {
  console.error(`Charger server not reachable at ${config.serverUrl}. Start it with \`npm run dev\`.`);
  process.exit(1);
}

const { limits } = config;
// The kill switch can be flipped while the agent runs: the file agent/PAUSED (the dashboard button creates it).
const isPaused = () => limits.paused || existsSync(config.pauseFilePath);
const currentLimits = () => ({ ...limits, paused: isPaused() });

/** The robot's state as shown on the dashboard. Money is in USDC base units (strings). */
function robotState() {
  const spent = spentLast24h(audit.payments(), Date.now());
  const left = limits.dailyBudget > spent ? limits.dailyBudget - spent : 0n;
  return {
    ...robot.snapshot(),
    budgetUsed: spent.toString(),
    budgetLeft: left.toString(),
    dailyBudget: limits.dailyBudget.toString(),
    planner: config.planner.apiKey ? "claude" : "rules",
    model: config.planner.apiKey ? config.planner.model : null,
    wallet: wallet.address,
    lowBatteryPct: config.lowBatteryPct,
    paused: isPaused(),
  };
}

/** One story line: printed here, and sent to the dashboard with its details. */
function log(phase, message, data = {}) {
  console.log(`[${phase}] ${message}`);
  control?.sendEvent({ phase, message, data, robot: robotState() });
}

/** Ask a human, in the terminal and on the dashboard at once. First answer wins; silence means no. */
const askHuman = (question, request) =>
  requestApproval({ question, request, control, timeoutMs: config.approvalTimeoutSeconds * 1000 });

console.log(`${robot.id} online | wallet ${wallet.address}`);
console.log(`  charger server  ${config.serverUrl}`);
console.log(`  dashboard       ${control ? config.controlUrl : "not connected (set AGENT_EVENTS_TOKEN to send events and take approvals there)"}`);
console.log(`  planner         ${config.planner.apiKey ? `claude (${config.planner.model})` : "rules (no ANTHROPIC_API_KEY set)"}`);
console.log(
  `  limits          per-tx ${formatUsdc(limits.maxPerTx)} | daily ${formatUsdc(limits.dailyBudget)} | approval above ${formatUsdc(limits.approvalThreshold)} USDC | ${limits.maxPaymentsPer10Min} payments / 10 min`,
);
console.log(`  battery         ${robot.snapshot().batteryPct}%, seeks a charge below ${config.lowBatteryPct}%\n`);

let attempts = 0; // charge attempts finished (paid, refused or failed)
let nextAttemptAt = 0;
let chargingFrom = null;
let lastCycleId = null;

while (true) {
  robot.tick();

  if (robot.status === "charging") {
    chargingFrom ??= Math.floor(robot.session.fromPct);
    const batteryPct = robot.snapshot().batteryPct;
    log("CHARGING", `battery ${chargingFrom}% → ${batteryPct}%`, { cycleId: lastCycleId, fromPct: chargingFrom, batteryPct, done: false });
  } else {
    if (chargingFrom !== null) {
      const batteryPct = robot.snapshot().batteryPct;
      log("CHARGING", `done: battery ${chargingFrom}% → ${batteryPct}%, back to delivering`, { cycleId: lastCycleId, fromPct: chargingFrom, batteryPct, done: true });
      console.log();
      chargingFrom = null;
      if (config.maxCycles > 0 && attempts >= config.maxCycles) break;
    }

    if (Date.now() >= nextAttemptAt) {
      const result = await runCycle({ robot, config, limits: currentLimits(), getLimits: currentLimits, charger, wallet, audit, askHuman, log });
      lastCycleId = result.cycleId;
      if (result.outcome !== "no_charge_needed") attempts++;
      if (result.outcome === "refused" || result.outcome === "failed") {
        log("RECORD", `no payment made (${result.outcome}); next attempt in ${config.retrySeconds}s`, { cycleId: result.cycleId, outcome: result.outcome, reasons: result.reasons ?? [] });
        console.log();
        nextAttemptAt = Date.now() + config.retrySeconds * 1000;
        if (config.maxCycles > 0 && attempts >= config.maxCycles) break;
      }
      if (result.outcome === "charging") continue; // show charging progress straight away
    }
  }

  await sleep(config.tickSeconds * 1000);
}

await control?.flush(); // let the last events reach the dashboard before exiting
