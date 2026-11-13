// Minimal x402 client: a test harness, not the real agent.
//   1. POST /devices/charger-001/charge with no payment  -> expect HTTP 402 + requirements
//   2. Build and sign the USDC transfer the 402 asks for (keys/test-payer.json)
//   3. Retry with the PAYMENT-SIGNATURE header           -> the server's facilitator submits
//      the transaction on Solana devnet, then the charger turns on
//
// Usage: npm run test:pay            (15 minutes on charger-001)
//        npm run test:pay -- 30 charger-002
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";

dotenv.config({ quiet: true });

const SERVER = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 4020}`;
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const minutes = Number(process.argv[2] ?? 15);
const deviceId = process.argv[3] ?? "charger-001";
const chargeUrl = `${SERVER}/devices/${deviceId}/charge`;

const rpc = createSolanaRpc(RPC_URL);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usdc = (baseUnits) => (Number(baseUnits) / 1e6).toFixed(2);

const payer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(new URL("../keys/test-payer.json", import.meta.url), "utf8"))),
);

function requestCharge(extraHeaders = {}) {
  return fetch(chargeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ minutes }),
  });
}

async function tokenAccountOf(owner, mint) {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return tokenAccount;
}

async function accountExists(account) {
  const { value } = await rpc.getAccountInfo(account, { encoding: "base64" }).send();
  return value !== null;
}

/** Create the merchant's USDC token account if it doesn't exist yet (the payer covers the rent). */
async function ensureMerchantTokenAccount(merchant, mint) {
  if (await accountExists(await tokenAccountOf(merchant, mint))) return;

  console.log("    merchant has no USDC token account yet; creating it (one-time, costs the payer ~0.002 SOL)");
  const createIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner: address(merchant),
    mint: address(mint),
  });
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([createIx], m),
    ),
  );
  const signature = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`creating the merchant token account failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      console.log(`    created: ${signature}`);
      return;
    }
  }
  throw new Error("timed out waiting for the merchant token account to be created");
}

// ---------------------------------------------------------------------------

console.log(`Payer   ${payer.address}`);
console.log(`Target  POST ${chargeUrl}  { minutes: ${minutes} }\n`);

// 1. Unpaid request -> 402
console.log("1. Requesting a charge without paying...");
const unpaid = await requestCharge();
if (unpaid.status !== 402) {
  console.error(`   Expected HTTP 402, got ${unpaid.status}:`, await unpaid.text());
  process.exit(1);
}

const client = new x402Client().register(
  "solana:*",
  // Pin legacy v0 transactions: the format every devnet RPC and explorer understands.
  new ExactSvmScheme(payer, { rpcUrl: RPC_URL, transactionVersions: [0] }),
);
const http = new x402HTTPClient(client);

const paymentRequired = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), await unpaid.json());
const wanted = paymentRequired.accepts[0];
console.log(`   402 Payment Required: ${usdc(wanted.amount)} USDC to ${wanted.payTo} on ${wanted.network}\n`);

// 2. Preflight, then sign the payment
console.log("2. Checking the payer wallet...");
const { value: lamports } = await rpc.getBalance(payer.address).send();
const payerTokenAccount = await tokenAccountOf(payer.address, wanted.asset);
const balance = (await accountExists(payerTokenAccount))
  ? BigInt((await rpc.getTokenAccountBalance(payerTokenAccount).send()).value.amount)
  : 0n;
console.log(`   ${(Number(lamports) / 1e9).toFixed(4)} SOL, ${usdc(balance)} USDC`);
if (balance < BigInt(wanted.amount)) {
  console.error(`   Not enough devnet USDC. Send some to ${payer.address} from https://faucet.circle.com (Solana Devnet).`);
  process.exit(1);
}
await ensureMerchantTokenAccount(wanted.payTo, wanted.asset);

const paymentPayload = await http.createPaymentPayload(paymentRequired);
const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);
console.log("   Signed a USDC transfer for the exact amount (the facilitator pays the network fee).\n");

// 3. Retry with the payment attached
console.log("3. Retrying with the PAYMENT-SIGNATURE header...");
const paid = await requestCharge(paymentHeaders);
const body = await paid.json();
if (!paid.ok) {
  console.error(`   Payment was not accepted (HTTP ${paid.status}):`, body);
  process.exit(1);
}

const receipt = http.getPaymentSettleResponse((name) => paid.headers.get(name));
console.log(`   HTTP ${paid.status} - charger is on.\n`);
console.log("Session:", body);
console.log("\nPAYMENT-RESPONSE:", receipt);

// 4. Replay protection: the same payment must not buy a second session on another charger.
const otherDevice = deviceId === "charger-002" ? "charger-003" : "charger-002";
console.log(`\n4. Replaying the same payment against ${otherDevice} (should be refused)...`);
const replay = await fetch(`${SERVER}/devices/${otherDevice}/charge`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...paymentHeaders },
  body: JSON.stringify({ minutes }),
});
console.log(`   HTTP ${replay.status}`, await replay.json());
