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
  pidFilePath: "agent/agent.pid", // lets `npm run demo:reset` see that the agent is running

  // Dashboard / control plane: where phase events go and where approvals are answered.
  controlUrl: env.AGENT_CONTROL_URL ?? env.CHARGER_SERVER_URL ?? `http://localhost:${env.PORT ?? 4020}`,
  eventsToken: env.AGENT_EVENTS_TOKEN ?? "",
  approvalTimeoutSeconds: num("APPROVAL_TIMEOUT_SECONDS", 60),

  robot: {
    id: "robot-01",
    location: { lat: 30.2747, lng: -97.7404 }, // Texas State Capitol, downtown Austin
    startBatteryPct: num("ROBOT_START_BATTERY_PCT", 35),
    drainPctPerSecond: num("ROBOT_DRAIN_PCT_PER_SEC", 0.5), // 35% -> 20% in about 30 seconds
    drainPctPerKm: num("ROBOT_DRAIN_PCT_PER_KM", 5), // what the drive to a charger costs; decides which chargers are in reach
    chargePctPerMinute: num("ROBOT_CHARGE_PCT_PER_MIN", 2), // a paid 15-minute session adds 30%
    // Cruising speed on the map, in metres per real second: a delivery robot's 6 km/h, in demo time.
    // With DEMO_SECONDS_PER_MINUTE=1 a simulated minute passes each second, so it covers 100 m per second.
    speedMetersPerSecond: (num("ROBOT_SPEED_KMH", 6) * 1000) / 3600 * (60 / num("DEMO_SECONDS_PER_MINUTE", 60)),
  },

  // Real seconds per simulated minute (60 = real time). The same setting scales the charging time on the server.
  secondsPerMinute: num("DEMO_SECONDS_PER_MINUTE", 60),
  lowBatteryPct: num("LOW_BATTERY_PCT", 20),
  targetBatteryPct: num("TARGET_BATTERY_PCT", 45),
  tickSeconds: num("AGENT_TICK_SECONDS", 5), // how often the loop runs
  retrySeconds: num("AGENT_RETRY_SECONDS", 20), // wait after a refused or failed attempt
  // Emergency override: at or below this battery level, if only a soft limit (rate limit, daily
  // budget) blocks the payment, the agent asks a human to allow that one payment.
  criticalBatteryPct: num("CRITICAL_BATTERY_PCT", 10),
  emergencyRetrySeconds: num("EMERGENCY_RETRY_SECONDS", 120), // after a "no" or no answer, wait this long before asking again
  maxCycles: num("AGENT_MAX_CYCLES", 0), // stop after this many charge attempts (0 = run forever)

  // Guardrails. Enforced in code by agent/guardrails.js; the LLM cannot change or bypass them.
  limits: {
    paused: env.AGENT_PAUSED === "true",
    maxPerTx: toBaseUnits(num("MAX_PER_TX_USDC", 1.0)),
    dailyBudget: toBaseUnits(num("DAILY_BUDGET_USDC", 5.0)),
    approvalThreshold: toBaseUnits(num("APPROVAL_THRESHOLD_USDC", 0.5)),
    maxPaymentsPer10Min: num("MAX_PAYMENTS_PER_10_MIN", 5),
    // The "10 minutes" are simulated minutes, scaled like a charging session: with
    // DEMO_SECONDS_PER_MINUTE=1 the window is 10 real seconds, so a sped-up demo doesn't hit the limit early.
    rateLimitWindowMs: 10 * num("DEMO_SECONDS_PER_MINUTE", 60) * 1000,
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
