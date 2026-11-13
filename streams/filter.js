// QuickNode Streams filter for Machine Pay Agent.
// Paste this whole file into the Stream's filter editor ("Customize your payload").
//
//   Network:  Solana devnet
//   Dataset:  Block (full blocks with all transactions)
//   Keeps:    successful transactions that move devnet USDC into the merchant wallet's
//             USDC token account
//   Sends:    [{ signature, slot, blockTime, from, to, amountUSDC }]  (nothing if no match)
//
// If the merchant wallet changes, update MERCHANT_WALLET below and in .env.

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // Circle USDC on devnet
const MERCHANT_WALLET = "AsCyNEGaHqxeyoJQkW5AXdDeTJpN9SiPviWY8sNiVG5w"; // charger owner
const USDC_DECIMALS = 6;

function main(stream) {
  const blocks = Array.isArray(stream.data) ? stream.data : [stream.data];
  const metadata = stream.metadata || {};
  const matches = [];

  for (const block of blocks) {
    if (!block || !Array.isArray(block.transactions)) continue;

    // A Solana block does not carry its own slot. With batch size 1 the batch range is
    // the slot; otherwise fall back to the parent slot + 1.
    const slot =
      block.slot !== undefined
        ? block.slot
        : blocks.length === 1 && metadata.batch_start_range !== undefined
          ? Number(metadata.batch_start_range)
          : block.parentSlot + 1;

    for (const tx of block.transactions) {
      if (!tx.meta || tx.meta.err) continue; // failed transactions moved nothing

      // USDC balance of every token account this transaction touched, before and after.
      const before = usdcBalances(tx.meta.preTokenBalances);
      const after = usdcBalances(tx.meta.postTokenBalances);

      // How much USDC arrived in token accounts owned by the merchant wallet?
      let received = 0;
      let merchantAccountIndex = null;
      for (const index in after) {
        if (after[index].owner !== MERCHANT_WALLET) continue;
        const delta = after[index].amount - (before[index] ? before[index].amount : 0);
        if (delta > 0) {
          received += delta;
          merchantAccountIndex = Number(index);
        }
      }
      if (received <= 0) continue;

      // The sender is the owner of the token account whose USDC went down the most.
      let from = null;
      let largestDrop = 0;
      for (const index in before) {
        const drop = before[index].amount - (after[index] ? after[index].amount : 0);
        if (drop > largestDrop) {
          largestDrop = drop;
          from = before[index].owner;
        }
      }

      matches.push({
        signature: tx.transaction.signatures[0],
        slot: slot,
        blockTime: block.blockTime,
        from: from,
        to: accountAddress(tx, merchantAccountIndex) || MERCHANT_WALLET, // the merchant's USDC token account
        amountUSDC: received / Math.pow(10, USDC_DECIMALS),
      });
    }
  }

  return matches.length ? matches : null; // null = send nothing for this batch
}

// { accountIndex: { owner, amount } } for the USDC mint only. Amounts are in base units.
function usdcBalances(tokenBalances) {
  const byIndex = {};
  for (const balance of tokenBalances || []) {
    if (balance.mint !== USDC_MINT) continue;
    byIndex[balance.accountIndex] = { owner: balance.owner, amount: Number(balance.uiTokenAmount.amount) };
  }
  return byIndex;
}

// Address of the account at `index`: static keys first, then keys loaded from lookup tables.
function accountAddress(tx, index) {
  if (index === null) return null;
  const loaded = tx.meta.loadedAddresses || {};
  const keys = (tx.transaction.message.accountKeys || []).concat(loaded.writable || [], loaded.readonly || []);
  const key = keys[index];
  return key && typeof key === "object" ? key.pubkey : key || null;
}
