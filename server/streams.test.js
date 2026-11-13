// Tests for QuickNode Streams webhook verification. Run with `npm test`.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { extractMatches, verifyStreamsRequest } from "./streams.js";

const TOKEN = "test-security-token";
const NOW = Date.parse("2026-11-13T12:00:00Z");
const BODY = JSON.stringify([{ signature: "sig1", slot: 1, blockTime: 1, from: "payer", to: "merchantAta", amountUSDC: 0.2 }]);

/** Build headers the way QuickNode does: HMAC-SHA256 over nonce + timestamp + body, hex. */
function sign(body, { token = TOKEN, nonce = randomUUID(), timestamp = String(Math.floor(NOW / 1000)) } = {}) {
  const signature = createHmac("sha256", token).update(nonce + timestamp + body).digest("hex");
  return { "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": signature };
}

const verify = (overrides = {}) => verifyStreamsRequest({ token: TOKEN, headers: sign(BODY), body: BODY, now: NOW, ...overrides });

describe("Streams webhook signature", () => {
  test("accepts a correctly signed request", () => {
    assert.deepEqual(verify(), { ok: true });
  });

  test("rejects an unsigned request", () => {
    const result = verify({ headers: { "content-type": "application/json" } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.reason, /unsigned/);
  });

  test("rejects a request missing any one of the three headers", () => {
    for (const missing of ["x-qn-nonce", "x-qn-timestamp", "x-qn-signature"]) {
      const headers = sign(BODY);
      delete headers[missing];
      assert.equal(verify({ headers }).ok, false, `without ${missing}`);
    }
  });

  test("rejects a signature made with the wrong token", () => {
    const result = verify({ headers: sign(BODY, { token: "someone-elses-token" }) });
    assert.deepEqual([result.ok, result.status], [false, 401]);
    assert.match(result.reason, /does not match/);
  });

  test("rejects a body that was changed after signing", () => {
    const tampered = BODY.replace("0.2", "200");
    assert.equal(verify({ headers: sign(BODY), body: tampered }).ok, false);
  });

  test("rejects a malformed signature without throwing", () => {
    for (const signature of ["", "abc", "zz".repeat(32), "a".repeat(63), "a".repeat(128)]) {
      const headers = { ...sign(BODY), "x-qn-signature": signature };
      assert.equal(verify({ headers }).ok, false, JSON.stringify(signature));
    }
  });

  test("rejects a replayed request (same nonce twice)", () => {
    const headers = sign(BODY, { nonce: "nonce-used-twice" });
    assert.equal(verify({ headers }).ok, true);
    const second = verify({ headers });
    assert.equal(second.ok, false);
    assert.match(second.reason, /replay/);
  });

  test("rejects a correctly signed but stale request", () => {
    const old = String(Math.floor(NOW / 1000) - 3600);
    const result = verify({ headers: sign(BODY, { timestamp: old }) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /timestamp/);
  });

  test("accepts a millisecond timestamp too", () => {
    assert.equal(verify({ headers: sign(BODY, { timestamp: String(NOW) }) }).ok, true);
  });

  test("the age check can be turned off, the signature check cannot", () => {
    const old = String(Math.floor(NOW / 1000) - 3600);
    assert.equal(verify({ headers: sign(BODY, { timestamp: old }), maxAgeSeconds: 0 }).ok, true);
    assert.equal(verify({ headers: sign(BODY, { token: "wrong" }), maxAgeSeconds: 0 }).ok, false);
  });

  test("refuses everything when no security token is configured", () => {
    const result = verify({ token: "" });
    assert.deepEqual([result.ok, result.status], [false, 503]);
  });
});

describe("Streams payload", () => {
  const match = { signature: "sig1", slot: 5, blockTime: 9, from: "payer", to: "ata", amountUSDC: 0.2 };

  test("reads the array the filter returns", () => {
    assert.deepEqual(extractMatches([match, { ...match, signature: "sig2" }]).map((m) => m.signature), ["sig1", "sig2"]);
  });
  test("reads a single object and wrapped lists", () => {
    assert.equal(extractMatches(match).length, 1);
    assert.equal(extractMatches({ matches: [match] }).length, 1);
    assert.equal(extractMatches({ data: [[match]] }).length, 1);
  });
  test("ignores entries that are not payment matches", () => {
    assert.deepEqual(extractMatches([null, {}, { signature: 5, amountUSDC: 1 }, { signature: "x" }, "text"]), []);
    assert.deepEqual(extractMatches({ hello: "test payload" }), []);
  });
});
