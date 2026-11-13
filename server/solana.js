// Our own look at the chain. The x402 facilitator already verifies and settles
// the payment; this is a second, independent check through SOLANA_RPC_URL that
// the settled transaction really moved enough USDC to the merchant wallet.
import { createSolanaRpc } from "@solana/kit";
import { config } from "./config.js";

const rpc = createSolanaRpc(config.rpcUrl);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sum of the merchant's USDC across a transaction's token balance list. */
function merchantUsdc(tokenBalances) {
  let total = 0n;
  for (const balance of tokenBalances ?? []) {
    if (balance.mint === config.usdcMint && balance.owner === config.merchantWallet) {
      total += BigInt(balance.uiTokenAmount.amount);
    }
  }
  return total;
}

/**
 * Returns one of:
 *   { status: "confirmed", received }  - tx succeeded and paid the merchant enough
 *   { status: "mismatch", detail }     - tx failed, or paid the merchant too little
 *   { status: "unavailable", detail }  - RPC couldn't show us the tx in time
 */
export async function checkUsdcReceived(txSignature, minBaseUnits) {
  let lastError = "transaction not found";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      const tx = await rpc
        .getTransaction(txSignature, {
          commitment: "confirmed",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
        })
        .send();
      if (!tx) continue;

      if (tx.meta?.err) return { status: "mismatch", detail: "transaction failed on-chain" };
      const received = merchantUsdc(tx.meta?.postTokenBalances) - merchantUsdc(tx.meta?.preTokenBalances);
      if (received < BigInt(minBaseUnits)) {
        return { status: "mismatch", detail: `merchant received ${received} base units, needed ${minBaseUnits}` };
      }
      return { status: "confirmed", received: received.toString() };
    } catch (error) {
      lastError = error.message;
    }
  }
  return { status: "unavailable", detail: lastError };
}
