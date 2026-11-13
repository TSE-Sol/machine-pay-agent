# Machine Pay Agent

Built from scratch during the UBC 2026 Hackathon (Nov 12–20, 2026). Agentic Payments & AI track.

An autonomous payment agent for machines. A simulated delivery robot notices its battery is low, finds a pay-to-power charging station, gets an x402 "402 Payment Required" price, pays in USDC on Solana devnet within a spending limit, and the charger turns on for the paid time.

```
server/      x402 charger server (simulated pay-to-power stations)   <- built
agent/       the robot's payment agent                                <- later
dashboard/   live dashboard                                           <- later
scripts/     key generation and a test payment client
keys/        local devnet keypairs (gitignored)
```

## Server

A small Express server that simulates pay-to-power charging stations. Asking a charger to turn on returns HTTP 402 with a price; paying that price in devnet USDC turns it on for the paid time.

### Setup

Requires Node.js 20+.

```bash
npm install
npm run keys            # creates keys/merchant.json and keys/test-payer.json, prints both public keys
cp .env.example .env    # then set MERCHANT_WALLET to the merchant public key
npm run dev             # starts the server on http://localhost:4020 (restarts on file changes)
```

To make a real test payment, fund the test payer on **Solana devnet** (see below), then run `npm run test:pay` in a second terminal.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4020` | Port the server listens on |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana devnet RPC |
| `USDC_MINT` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle's USDC mint on devnet |
| `MERCHANT_WALLET` | (required) | Public key of the charger owner's wallet; receives the USDC |
| `PRICE_USDC_PER_15MIN` | `0.20` | Price of 15 minutes of charging |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | Optional. x402 facilitator that verifies and settles payments |
| `DEMO_SECONDS_PER_MINUTE` | `60` | Optional. Set to `1` so a 15-minute session ends after 15 seconds |

### Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | `{ "ok": true }` |
| GET | `/devices` | Discovery list of chargers: id, name, type, location, price, status (`idle` or `charging`) |
| POST | `/devices/:id/charge` | Body `{ "minutes": 15 }` (15, 30 or 60). Unpaid: `402` with payment requirements. Paid: turns the charger on and returns `{ sessionId, deviceId, minutes, expiresAt, txSignature, explorerUrl }` |
| GET | `/devices/:id/status` | Current state and `secondsRemaining` |
| GET | `/events` | Server-Sent Events stream of everything that happens |

Other responses from the charge endpoint: `400` (bad `minutes` or malformed payment header), `404` (unknown charger), `409` (charger busy, or a payment that was already used), `502` (facilitator unreachable).

Event types on `/events` (each is also one console line):

| Event | Console line |
| --- | --- |
| `payment_required` | `[402] charger-001 15min 0.20 USDC` |
| `payment_verified` | `[VERIFIED] charger-001 payer=…` |
| `payment_settled` | `[PAID] charger-001 0.20 USDC sig=…` |
| `payment_rejected` | `[REJECTED] charger-001 reason=…` |
| `charging_started` | `[ON] charger-001 until 18:42:10` |
| `charging_ended` | `[OFF] charger-001` |

### How the x402 flow works

The server uses the official x402 v2 packages (`@x402/core`, `@x402/express`, `@x402/svm`) with the `exact` scheme on Solana devnet, and a hosted facilitator.

1. **Ask.** The robot sends `POST /devices/charger-001/charge` with `{ "minutes": 15 }` and no payment.
2. **Price.** The server answers `402 Payment Required`. The requirements are in the `PAYMENT-REQUIRED` header (base64 JSON) and, for readability, repeated as the JSON body: scheme `exact`, network `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), `amount` in USDC base units (`200000` = 0.20 USDC), `asset` (the USDC mint), `payTo` (the merchant wallet), and `extra.feePayer` (the facilitator's address).
3. **Sign.** The robot builds a USDC transfer for exactly that amount, signs it, and retries the same request with the signed transaction in a `PAYMENT-SIGNATURE` header (base64 JSON). The robot does not broadcast the transaction and needs no SOL: the facilitator pays the network fee.
4. **Verify.** The server passes the payment to the facilitator, which checks that it pays the right amount of the right token to the right wallet.
5. **Settle.** The facilitator co-signs and submits the transaction to Solana, and returns the transaction signature. The server then re-checks through its own RPC that the transaction succeeded and the merchant received at least the required USDC.
6. **Power on.** Only after settlement does the charger switch to `charging`. The response carries the session details plus a `PAYMENT-RESPONSE` header (base64 JSON with the transaction signature). The charger turns itself off at `expiresAt`.

Replay protection: a signed payment can be taken to settlement once, and each settled transaction signature can buy one session. Both sets are kept in memory, so they reset when the server restarts. Solana itself also refuses to process the same transaction twice.

Header names: x402 v2 uses `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`. These replace the `X-PAYMENT` and `X-PAYMENT-RESPONSE` headers of x402 v1.

### Funding the test wallets (devnet only)

`npm run keys` prints two addresses. The **test payer** needs:

- devnet USDC from [faucet.circle.com](https://faucet.circle.com) (choose USDC and Solana Devnet), and
- a little devnet SOL from [faucet.solana.com](https://faucet.solana.com). The x402 payment itself needs no SOL; the SOL covers a one-time setup step, where `test:pay` creates the merchant's USDC token account if it doesn't exist yet.

The **merchant** wallet needs nothing.

### Test payment

```bash
npm run test:pay                    # 15 minutes on charger-001
npm run test:pay -- 30 charger-002  # 30 minutes on charger-002
```

The script requests a charge, prints the 402, signs the payment with `keys/test-payer.json`, retries, prints the session and the Solana Explorer link, then replays the same payment against another charger to show it is refused.
