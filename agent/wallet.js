// The robot's wallet. For now this is a local devnet keypair (keys/test-payer.json).
// It signs x402 payments with the official client packages: @x402/core + @x402/svm.
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { formatUsdc } from "./config.js";

export async function loadWallet({ walletPath, rpcUrl, limits }) {
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))));

  // The guardrails in guardrails.js decide whether to pay. These two settings repeat the
  // most important limits inside the signing library itself, as a second lock: even if a
  // bug skipped the guardrails, the library would refuse to sign.
  const client = new x402Client()
    // Pin v0 transactions: the format every devnet RPC and explorer understands.
    .register("solana:*", new ExactSvmScheme(signer, { rpcUrl, transactionVersions: [0] }))
    .setSpendControls({ maxAmountPerPayment: `$${formatUsdc(limits.maxPerTx)}` })
    .registerPolicy((x402Version, requirements) =>
      requirements.filter(
        (r) =>
          limits.allowedNetworks.includes(r.network) &&
          limits.allowedAssets.includes(r.asset) &&
          limits.allowedPayTo.includes(r.payTo),
      ),
    );
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,

    /**
     * Sign a USDC transfer for exactly the requirement the guardrails approved.
     * Returns the HTTP header ({ "PAYMENT-SIGNATURE": ... }) to send with the retry.
     * The transaction is not broadcast here; the server's facilitator submits it.
     */
    async signPayment(paymentRequired, approvedRequirement) {
      const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [approvedRequirement] });
      return http.encodePaymentSignatureHeader(payload);
    },
  };
}
