// x402 payment handling for the charge endpoint, built on the official x402 v2
// packages (@x402/core, @x402/express, @x402/svm) and a hosted facilitator.
//
// Flow for POST /devices/:id/charge:
//   1. No PAYMENT-SIGNATURE header  -> 402 + payment requirements.
//   2. With the header              -> the facilitator verifies the signed USDC transfer.
//   3. Verified                     -> the facilitator submits it to Solana (settle).
//   4. Settled                      -> we double-check on-chain, then the route turns the charger on.
// We settle BEFORE switching power on: a physical device shouldn't run on an unsettled payment.
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { ExpressAdapter } from "@x402/express";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { config, priceBaseUnits } from "./config.js";
import { emit } from "./events.js";
import { checkUsdcReceived } from "./solana.js";

/** Adds the charge request's details to the request view the x402 library passes around. */
class ChargeRequestAdapter extends ExpressAdapter {
  constructor(req, charge) {
    super(req);
    this.charge = charge; // { deviceId, minutes }
  }
}

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl }))
  .register(config.network, new ExactSvmScheme({ rpcUrl: config.rpcUrl }))
  .onAfterVerify(async ({ result, transportContext }) => {
    const charge = transportContext?.request?.adapter?.charge;
    if (result.isValid && charge) emit("payment_verified", { ...charge, payer: result.payer });
  });

const httpServer = new x402HTTPResourceServer(resourceServer, {
  "POST /devices/:id/charge": {
    accepts: {
      scheme: "exact",
      network: config.network,
      payTo: config.merchantWallet,
      // The price depends on how many minutes this request asks for.
      price: ({ adapter }) => ({
        asset: config.usdcMint,
        amount: String(priceBaseUnits(adapter.charge.minutes)),
      }),
      maxTimeoutSeconds: 60,
    },
    description: "Pay-to-power robot charging session",
    mimeType: "application/json",
  },
});

/** Ask the facilitator what it supports (also gives us its fee-payer address). */
export async function initPayments() {
  await httpServer.initialize();
}

// Replay protection (in memory): a signed payment, and the transaction it settles as,
// can each buy exactly one session.
const usedPayments = new Set(); // signed transactions already taken to settlement
const usedSignatures = new Set(); // on-chain tx signatures already redeemed

function signedTransactionOf(paymentHeader) {
  try {
    return decodePaymentSignatureHeader(paymentHeader).payload?.transaction ?? null;
  } catch {
    return null;
  }
}

const reply = (status, body, headers = {}) => ({ paid: false, status, headers, body });

/**
 * Step 1 + 2. Returns either
 *   { paid: false, status, headers, body }  - send this response (402, 400, 409 or 502), or
 *   { paid: true, settle }                  - payment verified; call settle() to collect it.
 */
export async function checkPayment(req, charge) {
  const reject = (reason) => emit("payment_rejected", { ...charge, reason });

  const adapter = new ChargeRequestAdapter(req, charge);
  const paymentHeader = adapter.getHeader("payment-signature");
  const context = { adapter, path: req.path, method: req.method, paymentHeader };

  const signedTransaction = paymentHeader ? signedTransactionOf(paymentHeader) : null;
  if (paymentHeader && !signedTransaction) {
    reject("malformed_payment_header");
    return reply(400, { error: "malformed_payment_header" });
  }
  if (signedTransaction && usedPayments.has(signedTransaction)) {
    reject("payment_already_used");
    return reply(409, { error: "payment_already_used" });
  }

  let result;
  try {
    result = await httpServer.processHTTPRequest(context);
  } catch (error) {
    reject(`facilitator_error: ${error.message}`);
    return reply(502, { error: "facilitator_error", message: error.message });
  }

  if (result.type === "payment-error") {
    // The library puts the requirements in the PAYMENT-REQUIRED header (base64 JSON).
    // We also return them as the JSON body so they're easy to read with curl.
    const { status, headers } = result.response;
    const paymentRequired = decodePaymentRequiredHeader(headers["PAYMENT-REQUIRED"]);
    if (paymentHeader) {
      reject(paymentRequired.error ?? "payment_invalid");
    } else {
      emit("payment_required", { ...charge, amount: paymentRequired.accepts[0].amount });
    }
    return reply(status, paymentRequired, headers);
  }

  const { paymentPayload, paymentRequirements, declaredExtensions } = result;

  /** Step 3 + 4. Returns { ok: true, txSignature, payer, headers } or { ok: false, status, headers, body }. */
  async function settle() {
    usedPayments.add(signedTransaction);

    let settlement;
    try {
      settlement = await httpServer.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, {
        request: context,
      });
    } catch (error) {
      reject(`facilitator_error: ${error.message}`);
      return { ok: false, status: 502, headers: {}, body: { error: "facilitator_error", message: error.message } };
    }

    if (!settlement.success) {
      reject(settlement.errorReason);
      const { status, headers } = settlement.response;
      return { ok: false, status, headers, body: { error: settlement.errorReason, message: settlement.errorMessage } };
    }

    const txSignature = settlement.transaction;
    if (usedSignatures.has(txSignature)) {
      reject("transaction_already_used");
      return { ok: false, status: 409, headers: {}, body: { error: "transaction_already_used" } };
    }
    usedSignatures.add(txSignature);

    const onChain = await checkUsdcReceived(txSignature, paymentRequirements.amount);
    if (onChain.status === "mismatch") {
      reject(`onchain_check_failed: ${onChain.detail}`);
      return { ok: false, status: 402, headers: {}, body: { error: "onchain_check_failed", message: onChain.detail, txSignature } };
    }
    if (onChain.status === "unavailable") {
      console.warn(`[WARN] could not re-check ${txSignature} via RPC (${onChain.detail}); trusting the facilitator's settlement`);
    }

    emit("payment_settled", {
      ...charge,
      amount: paymentRequirements.amount,
      payer: settlement.payer,
      txSignature,
      onChainCheck: onChain.status,
    });
    // settlement.headers carries PAYMENT-RESPONSE (base64 JSON with the tx signature).
    return {
      ok: true,
      txSignature,
      payer: settlement.payer,
      amount: paymentRequirements.amount,
      onChainCheck: onChain.status,
      headers: settlement.headers,
    };
  }

  return { paid: true, settle };
}
