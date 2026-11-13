// HTTP client for the charger server. No keys and no signing in here: this file
// only asks questions and delivers an already-signed payment.
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";

export function createChargerClient(serverUrl) {
  const requestCharge = (deviceId, minutes, extraHeaders = {}) =>
    fetch(`${serverUrl}/devices/${deviceId}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({ minutes }),
    });

  const getJson = async (path) => {
    const response = await fetch(`${serverUrl}${path}`);
    if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`);
    return response.json();
  };

  return {
    listDevices: () => getJson("/devices"),
    getStatus: (deviceId) => getJson(`/devices/${deviceId}/status`),

    /**
     * Ask for a charge without paying. The expected answer is HTTP 402 with the
     * payment requirements in the PAYMENT-REQUIRED header.
     * Returns { ok: true, paymentRequired } or { ok: false, status, detail }.
     */
    async requestQuote(deviceId, minutes) {
      const response = await requestCharge(deviceId, minutes);
      if (response.status !== 402) {
        const body = await response.json().catch(() => ({}));
        return { ok: false, status: response.status, detail: body.error ?? "expected HTTP 402" };
      }
      try {
        const paymentRequired = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
        return { ok: true, paymentRequired };
      } catch {
        return { ok: false, status: 402, detail: "402 without a readable PAYMENT-REQUIRED header" };
      }
    },

    /**
     * Retry the request with the signed payment attached.
     * Returns { status, body, receipt } where receipt is the decoded PAYMENT-RESPONSE header (or null).
     */
    async submitPayment(deviceId, minutes, paymentHeaders) {
      const response = await requestCharge(deviceId, minutes, paymentHeaders);
      const body = await response.json().catch(() => null);
      let receipt = null;
      try {
        const header = response.headers.get("PAYMENT-RESPONSE");
        if (header) receipt = decodePaymentResponseHeader(header);
      } catch {
        // an unreadable receipt is treated the same as no receipt
      }
      return { status: response.status, body, receipt };
    },
  };
}
