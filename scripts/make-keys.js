// Generates two Solana devnet keypairs (skips any that already exist):
//   keys/merchant.json    - the charger owner's wallet (receives USDC)
//   keys/test-payer.json  - the wallet scripts/test-pay.js pays from
// Files use the Solana CLI format: a JSON array of 64 bytes (32 secret + 32 public).
// The keys/ folder is gitignored. These are devnet-only keys; never fund them on mainnet.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const KEYS_DIR = new URL("../keys/", import.meta.url);

function generateKeypairBytes() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const secret = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return Uint8Array.from([...secret, ...pub]);
}

async function ensureKeypair(name) {
  const file = new URL(`${name}.json`, KEYS_DIR);
  let bytes;
  let note;
  if (existsSync(file)) {
    bytes = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")));
    note = "already existed, kept";
  } else {
    bytes = generateKeypairBytes();
    writeFileSync(file, JSON.stringify(Array.from(bytes)), { mode: 0o600 });
    note = "created";
  }
  const { address } = await createKeyPairSignerFromBytes(bytes);
  console.log(`${`keys/${name}.json`.padEnd(22)} ${address}  (${note})`);
  return address;
}

mkdirSync(KEYS_DIR, { recursive: true });
const merchant = await ensureKeypair("merchant");
await ensureKeypair("test-payer");

console.log(`\nPut the merchant public key in .env:\n  MERCHANT_WALLET=${merchant}`);
