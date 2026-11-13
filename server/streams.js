// QuickNode Streams webhook: signature verification and payload parsing.
//
// QuickNode signs every delivery with the Stream's security token:
//   X-QN-Signature = hex( HMAC-SHA256( key = token, message = nonce + timestamp + body ) )
// with the nonce and timestamp sent in X-QN-Nonce and X-QN-Timestamp. The body is the
// JSON text exactly as sent (after gzip decompression, if compression is on).
import { createHmac, timingSafeEqual } from "node:crypto";

const seenNonces = new Map(); // nonce -> time first seen, to refuse replays
const NONCE_MEMORY_MS = 60 * 60 * 1000;

/**
 * Returns { ok: true } or { ok: false, status, reason }.
 *   token   - the Stream's security token (QUICKNODE_STREAMS_TOKEN)
 *   headers - request headers (lower-cased names, as Node provides them)
 *   body    - raw request body as a string
 */
export function verifyStreamsRequest({ token, headers, body, maxAgeSeconds = 900, now = Date.now() }) {
  if (!token) return { ok: false, status: 503, reason: "QUICKNODE_STREAMS_TOKEN is not set, so no webhook can be trusted" };

  const nonce = headers["x-qn-nonce"];
  const timestamp = headers["x-qn-timestamp"];
  const signature = headers["x-qn-signature"];
  if (!nonce || !timestamp || !signature) return { ok: false, status: 401, reason: "unsigned request (missing X-QN-* headers)" };
  if (!/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, status: 401, reason: "malformed signature" };

  const expected = createHmac("sha256", Buffer.from(token, "utf8")).update(nonce + timestamp + body, "utf8").digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return { ok: false, status: 401, reason: "signature does not match" };

  // Signed correctly. Now refuse stale or repeated deliveries.
  if (maxAgeSeconds > 0) {
    const sent = Number(timestamp);
    const sentMs = sent > 1e12 ? sent : sent * 1000; // accept seconds or milliseconds
    if (!Number.isFinite(sentMs)) return { ok: false, status: 401, reason: "unreadable timestamp" };
    if (Math.abs(now - sentMs) > maxAgeSeconds * 1000) return { ok: false, status: 401, reason: "timestamp outside the allowed window" };
  }
  for (const [old, seenAt] of seenNonces) if (now - seenAt > NONCE_MEMORY_MS) seenNonces.delete(old);
  if (seenNonces.has(nonce)) return { ok: false, status: 401, reason: "nonce already used (replay)" };
  seenNonces.set(nonce, now);

  return { ok: true };
}

/**
 * Pull the filter's matches out of a webhook body. streams/filter.js returns an array of
 * { signature, slot, blockTime, from, to, amountUSDC }; a single object or a wrapper
 * object ({ matches: [...] } or { data: [...] }) is accepted too.
 */
export function extractMatches(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.matches ?? payload?.data ?? [payload]);
  return (Array.isArray(list) ? list : [list])
    .flat()
    .filter((m) => m && typeof m.signature === "string" && Number.isFinite(Number(m.amountUSDC)))
    .map((m) => ({
      signature: m.signature,
      slot: m.slot ?? null,
      blockTime: m.blockTime ?? null,
      from: m.from ?? null,
      to: m.to ?? null,
      amountUSDC: Number(m.amountUSDC),
    }));
}
