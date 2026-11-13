// Agent configuration, read from .env (see .env.example). Every safety limit lives here.
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = process.env;
const num = (name, fallback) => (env[name] === undefined || env[name] === "" ? fallback : Number(env[name]));
const list = (value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const USDC_DECIMALS = 6;
/** 0.20 -> 200000 (USDC base units, as a BigInt). */
export const toBaseUnits = (usdc) => BigInt(Math.round(Number(usdc) * 10 ** USDC_DECIMALS));
/** 200000 -> "0.20" */
export const formatUsdc = (baseUnits) => (Number(baseUnits) / 10 ** USDC_DECIMALS).toFixed(2);

export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const config = {
  serverUrl: env.CHARGER_SERVER_URL ?? `http://localhost:${env.PORT ?? 4020}`,
  rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  walletPath: env.AGENT_WALLET_PATH ?? "keys/test-payer.json",
  auditLogPath: env.AGENT_AUDIT_LOG ?? "agent/audit.log",
  pauseFilePath: "agent/PAUSED",

  robot: {
    id: "robot-01",
    location: { lat: 30.2747, lng: -97.7404 }, // Texas State Capitol, downtown Austin
    startBatteryPct: num("ROBOT_START_BATTERY_PCT", 35),
    drainPctPerSecond: num("ROBOT_DRAIN_PCT_PER_SEC", 0.5), // 35% -> 20% in about 30 seconds
    chargePctPerMinute: num("ROBOT_CHARGE_PCT_PER_MIN", 2), // a paid 15-minute session adds 30%
  },

  lowBatteryPct: num("LOW_BATTERY_PCT", 20),
  targetBatteryPct: num("TARGET_BATTERY_PCT", 45),
  tickSeconds: num("AGENT_TICK_SECONDS", 5), // how often the loop runs
  retrySeconds: num("AGENT_RETRY_SECONDS", 20), // wait after a refused or failed attempt
  maxCycles: num("AGENT_MAX_CYCLES", 0), // stop after this many charge attempts (0 = run forever)

  // Guardrails. Enforced in code by agent/guardrails.js; the LLM cannot change or bypass them.
  limits: {
    paused: env.AGENT_PAUSED === "true",
    maxPerTx: toBaseUnits(num("MAX_PER_TX_USDC", 1.0)),
    dailyBudget: toBaseUnits(num("DAILY_BUDGET_USDC", 5.0)),
    approvalThreshold: toBaseUnits(num("APPROVAL_THRESHOLD_USDC", 0.5)),
    maxPaymentsPer10Min: num("MAX_PAYMENTS_PER_10_MIN", 5),
    // The only recipients, networks and tokens this agent will ever pay.
    allowedPayTo: list(env.ALLOWED_PAY_TO ?? env.MERCHANT_WALLET),
    allowedNetworks: [SOLANA_DEVNET],
    allowedAssets: [env.USDC_MINT ?? DEVNET_USDC_MINT],
  },

  planner: {
    apiKey: env.ANTHROPIC_API_KEY ?? "",
    model: env.AGENT_MODEL ?? "claude-opus-5-5",
  },
};

export const SESSION_MINUTES = [15, 30, 60];
