# mppx-arc

MPP (Machine Payments Protocol) payment method for Circle's Arc chain.

USDC-native charge + session support. The first MPP integration on Arc.

## What is this?

[MPP](https://mpp.dev) is the open standard for machine-to-machine payments via HTTP 402, co-developed by Tempo and Stripe. This package brings MPP to [Arc](https://arc.circle.com), Circle's sovereign L1 blockchain where USDC is the native gas token.

**Two payment modes:**

- **Charge** — One-time payments via ERC-3009 `transferWithAuthorization`. Client signs, server broadcasts (gasless for client). Also supports push mode (client broadcasts).
- **Session** — Streaming micropayments via payment channels. Client deposits USDC into an escrow contract, then signs off-chain vouchers for each request. Sub-100ms verification, $0.0001 per request possible.

## Architecture

```
Agent (Client)                          Server
  |                                       |
  |-- GET /api/resource ----------------->|
  |<-- 402 Payment Required --------------|
  |   WWW-Authenticate: Payment           |
  |   method="arc", intent="charge"       |
  |                                       |
  |-- Sign ERC-3009 authorization         |
  |                                       |
  |-- Authorization: Payment <cred> ----->|
  |                                       |
  |   Server verifies signature           |
  |   Server broadcasts transfer          |
  |                                       |
  |<-- 200 OK + Payment-Receipt ----------|
```

For sessions, the first request opens a channel (1 on-chain tx), then all subsequent requests use off-chain vouchers (CPU-only verification):

```
Agent                                   Server
  |                                       |
  |-- Open channel (1 on-chain tx) ------>|
  |-- Voucher #1 (off-chain, ~1ms) ----->|
  |-- Voucher #2 (off-chain, ~1ms) ----->|
  |-- Voucher #3 (off-chain, ~1ms) ----->|
  |-- ... hundreds of requests ...        |
  |                                       |
  |   Server auto-settles at threshold    |
  |   (batch on-chain settlement)         |
```

## Deployed Contracts

| Network | Contract | Address |
|---------|----------|---------|
| Arc Testnet | ArcStreamChannel | [`0x805aCAD6064CBfABac71a021c3ab432920925533`](https://testnet.arcscan.app/address/0x805aCAD6064CBfABac71a021c3ab432920925533) |
| Arc Testnet | USDC | `0x3600000000000000000000000000000000000000` |

## Quick Start

### Install

```bash
npm install @mppx-arc/mpp viem
```

### Server (Hono)

```typescript
import { Hono } from "hono";
import { verifyCharge, arcTestnet, ARC_USDC } from "@mppx-arc/mpp";

const app = new Hono();

app.get("/api/data", async (c) => {
  const auth = c.req.header("Authorization");

  if (!auth?.startsWith("Payment ")) {
    return c.json({
      method: "arc",
      intent: "charge",
      recipient: SERVER_ADDRESS,
      amount: "100000", // $0.10
      chainId: arcTestnet.id,
      currency: ARC_USDC,
    }, 402);
  }

  const credential = JSON.parse(
    Buffer.from(auth.slice(8), "base64url").toString()
  );

  const receipt = await verifyCharge({
    credential,
    expectedRecipient: SERVER_ADDRESS,
    expectedAmount: 100000n,
    publicClient,
    walletClient,
  });

  return c.json({ data: "paid content", receipt });
});
```

### Client (Agent)

```typescript
import { createChargeCredential, arcTestnet } from "@mppx-arc/mpp";

// 1. Request resource, get 402
const res = await fetch("https://api.example.com/data");
const challenge = await res.json(); // { recipient, amount, chainId, currency }

// 2. Create payment credential
const credential = await createChargeCredential({
  challenge,
  walletClient,
  publicClient,
  mode: "pull", // gasless for client
});

// 3. Retry with payment
const paid = await fetch("https://api.example.com/data", {
  headers: {
    Authorization: `Payment ${btoa(JSON.stringify(credential))}`,
  },
});
```

## Project Structure

```
mppx-arc/
├── packages/
│   ├── contracts/          # Solidity (Foundry)
│   │   ├── src/ArcStreamChannel.sol
│   │   ├── test/           # 31 tests (incl. fuzz + ERC-1271)
│   │   └── script/Deploy.s.sol
│   └── mpp/                # TypeScript plugin
│       ├── src/
│       │   ├── client/     # Charge + Session client
│       │   ├── server/     # Charge + Session server
│       │   ├── constants.ts
│       │   ├── types.ts
│       │   └── abi.ts
│       └── test/           # 26 tests
├── examples/
│   ├── server/             # Hono server with charge + session endpoints
│   └── agent/              # Autonomous agent client
├── .env.example
└── README.md
```

## Tests

```bash
# Solidity (31 tests)
cd packages/contracts && forge test -vvv

# TypeScript (26 tests)
cd packages/mpp && npm test
```

## Key Differentiators

vs. other MPP integrations (Abstract, Avalanche, Monad):

| Feature | mppx-arc | Abstract | Avalanche |
|---------|----------|----------|-----------|
| TypeScript tests | 26 | 0 | 0 |
| Foundry tests | 31 (incl. fuzz) | 17 | 22 |
| Push + Pull charge | Yes | Pull only | N/A |
| Session support | Yes | Yes | Yes |
| Replay protection | Yes (Store-based) | No | No |
| Auto-settle batching | Yes (threshold) | No | Yes |
| ERC-1271 wallets | Yes | Yes | No |
| USDC-native chain | Yes (Arc) | No | No |

## Arc Chain Details

| Property | Value |
|----------|-------|
| Chain ID | 5042002 |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Gas Token | USDC (native) |
| Faucet | `https://faucet.circle.com` |

## License

MIT
