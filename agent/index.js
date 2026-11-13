// Entry point: `npm run agent`. Starts the simulated robot and runs the decision loop.
import { existsSync } from "node:fs";
import { askInTerminal } from "./approval.js";
import { AuditLog } from "./audit.js";
import { createChargerClient } from "./charger.js";
import { config, formatUsdc } from "./config.js";
import { runCycle } from "./loop.js";
import { Robot } from "./robot.js";
import { loadWallet } from "./wallet.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (phase, message) => console.log(`[${phase}] ${message}`);

if (config.limits.allowedPayTo.length === 0) {
  console.error("No allowed recipients. Set MERCHANT_WALLET (or ALLOWED_PAY_TO) in .env; the agent only pays allowlisted wallets.");
  process.exit(1);
}

const robot = new Robot(config.robot);
const audit = new AuditLog(config.auditLogPath);
const charger = createChargerClient(config.serverUrl);
const wallet = await loadWallet({ walletPath: config.walletPath, rpcUrl: config.rpcUrl, limits: config.limits });

try {
  await charger.listDevices();
} catch {
  console.error(`Charger server not reachable at ${config.serverUrl}. Start it with \`npm run dev\`.`);
  process.exit(1);
}

const { limits } = config;
console.log(`${robot.id} online | wallet ${wallet.address}`);
console.log(`  charger server  ${config.serverUrl}`);
console.log(`  planner         ${config.planner.apiKey ? `claude (${config.planner.model})` : "rules (no ANTHROPIC_API_KEY set)"}`);
console.log(
  `  limits          per-tx ${formatUsdc(limits.maxPerTx)} | daily ${formatUsdc(limits.dailyBudget)} | approval above ${formatUsdc(limits.approvalThreshold)} USDC | ${limits.maxPaymentsPer10Min} payments / 10 min`,
);
console.log(`  battery         ${robot.snapshot().batteryPct}%, seeks a charge below ${config.lowBatteryPct}%\n`);

// The kill switch can be flipped while the agent runs: create the file agent/PAUSED.
const currentLimits = () => ({ ...limits, paused: limits.paused || existsSync(config.pauseFilePath) });

let attempts = 0; // charge attempts finished (paid, refused or failed)
let nextAttemptAt = 0;
let chargingFrom = null;

while (true) {
  robot.tick();

  if (robot.status === "charging") {
    chargingFrom ??= robot.session.fromPct;
    log("CHARGING", `battery ${Math.floor(chargingFrom)}% → ${robot.snapshot().batteryPct}%`);
  } else {
    if (chargingFrom !== null) {
      log("CHARGING", `done: battery ${Math.floor(chargingFrom)}% → ${robot.snapshot().batteryPct}%, back to delivering\n`);
      chargingFrom = null;
      if (config.maxCycles > 0 && attempts >= config.maxCycles) break;
    }

    if (Date.now() >= nextAttemptAt) {
      const result = await runCycle({ robot, config, limits: currentLimits(), charger, wallet, audit, askHuman: askInTerminal, log });
      if (result.outcome !== "no_charge_needed") attempts++;
      if (result.outcome === "refused" || result.outcome === "failed") {
        log("RECORD", `no payment made (${result.outcome}); next attempt in ${config.retrySeconds}s\n`);
        nextAttemptAt = Date.now() + config.retrySeconds * 1000;
        if (config.maxCycles > 0 && attempts >= config.maxCycles) break;
      }
      if (result.outcome === "charging") continue; // show charging progress straight away
    }
  }

  await sleep(config.tickSeconds * 1000);
}
