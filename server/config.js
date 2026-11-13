// Loads and validates configuration from .env (see .env.example).
import dotenv from "dotenv";
import { isAddress } from "@solana/kit";

dotenv.config({ quiet: true });

const env = process.env;

const USDC_DECIMALS = 6;
const pricePer15MinUsdc = Number(env.PRICE_USDC_PER_15MIN ?? "0.20");

export const config = {
  port: Number(env.PORT ?? 4020),
  rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  usdcMint: env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  merchantWallet: env.MERCHANT_WALLET ?? "",
  pricePer15MinUsdc,
  // USDC has 6 decimals, so 0.20 USDC = 200000 base units.
  pricePer15MinBaseUnits: Math.round(pricePer15MinUsdc * 10 ** USDC_DECIMALS),
  // x402 facilitator: verifies the signed payment and submits it to Solana.
  facilitatorUrl: env.FACILITATOR_URL ?? "https://x402.org/facilitator",
  // x402 v2 names networks with CAIP-2 ids. This one is Solana devnet.
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  // Shared secret for the agent's event feed and the dashboard's controls (approve, deny, pause).
  agentEventsToken: env.AGENT_EVENTS_TOKEN ?? "",
  // QuickNode Streams security token: used to verify the signature on every webhook.
  streamsToken: env.QUICKNODE_STREAMS_TOKEN ?? "",
  // Reject Streams webhooks signed longer ago than this (0 turns the age check off).
  streamsMaxAgeSeconds: Number(env.STREAMS_MAX_AGE_SECONDS ?? 900),
  // Real seconds per paid "minute". Leave at 60; lower it (e.g. 1) for quick demos.
  secondsPerMinute: Number(env.DEMO_SECONDS_PER_MINUTE ?? 60),
};

export const ALLOWED_MINUTES = [15, 30, 60];

/** Price of a session in USDC base units (integer). */
export function priceBaseUnits(minutes) {
  return config.pricePer15MinBaseUnits * (minutes / 15);
}

/** Format base units as a human string, e.g. 200000 -> "0.20". */
export function formatUsdc(baseUnits) {
  return (Number(baseUnits) / 10 ** USDC_DECIMALS).toFixed(2);
}

export function explorerUrl(txSignature) {
  return `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
}

/** Stop early with a clear message if the config can't work. */
export function assertConfig() {
  const problems = [];
  if (!isAddress(config.merchantWallet)) {
    problems.push("MERCHANT_WALLET must be a Solana public key (run `npm run keys`, then copy the merchant key into .env)");
  }
  if (!isAddress(config.usdcMint)) problems.push("USDC_MINT must be a Solana mint address");
  if (!(config.pricePer15MinBaseUnits > 0)) problems.push("PRICE_USDC_PER_15MIN must be a positive number");
  if (!(config.secondsPerMinute > 0)) problems.push("DEMO_SECONDS_PER_MINUTE must be a positive number");
  if (problems.length > 0) {
    console.error("Config error:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
}
