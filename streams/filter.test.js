// Tests for the QuickNode Streams filter, run against a real Solana devnet block
// (streams/fixtures/devnet-block.json) that contains one of this project's payments.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";

// filter.js is written for QuickNode's sandbox (a bare `function main`, no exports),
// so load it the same way: evaluate the file and pick up `main`.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("./filter.js", import.meta.url), "utf8") + "\nthis.main = main;", context);
const main = (stream) => JSON.parse(JSON.stringify(context.main(stream) ?? null));

const fixture = JSON.parse(readFileSync(new URL("./fixtures/devnet-block.json", import.meta.url), "utf8"));
const MERCHANT = "AsCyNEGaHqxeyoJQkW5AXdDeTJpN9SiPviWY8sNiVG5w";
const PAYER = "7cpH5zEAFUJTszSLXk3Uz5qedVkmxE2RJwbPHZbRM9hH";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYMENT = "4cPw27u5EMD1H9M9YMkXXyZAPx6adacSKB1VnRqLRDcqwyifYzL2shoW3eAwG5cExWquwKefiyayX5xftz83nmes";

const stream = (block = fixture.block, metadata = {}) => ({
  data: [block],
  metadata: { network: "solana-devnet", dataset: "block", batch_start_range: fixture.slot, batch_end_range: fixture.slot, ...metadata },
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const paymentTx = (block) => block.transactions.find((tx) => tx.transaction.signatures[0] === PAYMENT);

describe("Streams filter", () => {
  test("keeps only the USDC payment to the merchant, as a compact payload", () => {
    assert.equal(fixture.block.transactions.length, 3, "fixture holds the payment and two unrelated transactions");
    assert.deepEqual(main(stream()), [
      {
        signature: PAYMENT,
        slot: fixture.slot,
        blockTime: fixture.block.blockTime,
        from: PAYER,
        to: "FJaeXfKpRaXRWH92rcFrhwMp955ebAydPPZJPt5nJ5fu", // the merchant's USDC token account
        amountUSDC: 0.2,
      },
    ]);
  });

  test("sends nothing for a block with no matching transaction", () => {
    const block = clone(fixture.block);
    block.transactions = block.transactions.filter((tx) => tx.transaction.signatures[0] !== PAYMENT);
    assert.equal(main(stream(block)), null);
  });

  test("ignores a failed transaction", () => {
    const block = clone(fixture.block);
    paymentTx(block).meta.err = { InstructionError: [0, "Custom"] };
    assert.equal(main(stream(block)), null);
  });

  test("ignores USDC sent to a different wallet", () => {
    const block = clone(fixture.block);
    for (const list of [paymentTx(block).meta.preTokenBalances, paymentTx(block).meta.postTokenBalances]) {
      for (const balance of list) if (balance.owner === MERCHANT) balance.owner = "SomeoneElse1111111111111111111111111111111";
    }
    assert.equal(main(stream(block)), null);
  });

  test("ignores a different token sent to the merchant", () => {
    const block = clone(fixture.block);
    for (const list of [paymentTx(block).meta.preTokenBalances, paymentTx(block).meta.postTokenBalances]) {
      for (const balance of list) if (balance.mint === USDC) balance.mint = "OtherMint11111111111111111111111111111111111";
    }
    assert.equal(main(stream(block)), null);
  });

  test("ignores USDC leaving the merchant wallet", () => {
    const block = clone(fixture.block);
    const meta = paymentTx(block).meta;
    [meta.preTokenBalances, meta.postTokenBalances] = [meta.postTokenBalances, meta.preTokenBalances]; // run the transfer backwards
    assert.equal(main(stream(block)), null);
  });

  test("handles account keys given as objects (jsonParsed encoding)", () => {
    const block = clone(fixture.block);
    const message = paymentTx(block).transaction.message;
    message.accountKeys = message.accountKeys.map((pubkey) => ({ pubkey, signer: false, writable: true }));
    assert.equal(main(stream(block))[0].to, "FJaeXfKpRaXRWH92rcFrhwMp955ebAydPPZJPt5nJ5fu");
  });

  test("handles a batch of several blocks and empty input", () => {
    const empty = { ...clone(fixture.block), transactions: [] };
    const result = main({ data: [empty, fixture.block], metadata: {} });
    assert.equal(result.length, 1);
    assert.equal(result[0].slot, fixture.block.parentSlot + 1, "falls back to parentSlot + 1 without a single-block range");
    assert.equal(main({ data: [], metadata: {} }), null);
    assert.equal(main({ data: [null, {}], metadata: {} }), null);
  });
});
