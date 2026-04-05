# mppx-arc

MPP (Machine Payments Protocol) payment method for Circle's Arc chain.

USDC-native charge + session support. The first MPP integration on Arc.

## Why MPP on Arc?

Arc already supports [x402](https://x402.org) for machine payments. MPP complements it — they solve different problems:

| | x402 | MPP |
|---|---|---|
| Best for | Simple one-time payments | High-frequency agent workflows |
| Payment model | Per-request on-chain tx | Session channels (1 tx → 100s of requests) |
| Streaming | No | SSE pay-per-token |
| HTTP standard | Custom headers | RFC-compliant `WWW-Authenticate` / `Authorization` |
| Standards body | None | IETF Internet-Draft |
| Backed by | Coinbase, Circle | Stripe, Tempo, Paradigm |

Both use USDC. Both work on Arc. Supporting both means more agents can pay for your services.

## What is this?

[MPP](https://mpp.dev) is the open standard for machine-to-machine payments via HTTP 402, co-developed by Tempo and Stripe. This package brings MPP to [Arc](https://arc.circle.com), Circle's sovereign L1 blockchain where USDC is the native gas token.

**Payment modes:**

- **Charge** — One-time USDC payments. Push mode (client broadcasts) or pull mode (client signs ERC-3009, server broadcasts — gasless for client).
- **Session** — Streaming micropayments via payment channels. Client deposits USDC into escrow, then signs off-chain vouchers for each request. Sub-ms verification, $0.0001 per request possible.
- **SSE Streaming** — Pay-per-token streaming for LLM responses. Voucher budget gating with automatic cutoff.
- **HTML Payment Page** — Browser-friendly 402 page for non-agent clients.

**USDC only** — no bridged tokens, no extra gas tokens. Arc's native currency.

## Architecture

```
Agent (Client)                          Server
  |                                       |
  |-- GET /api/resource ----------------->|
  |<-- 402 + WWW-Authenticate: Payment --|
  |   method="arc", intent="charge"       |
  |                                       |
  |-- Sign ERC-3009 authorization         |
  |                                       |
  |-- Authorization: Payment <cred> ----->|
  |                                       |
  |   Verify signature (ecrecover)        |
  |   Broadcast transferWithAuth          |
  |                                       |
  |<-- 200 OK + Payment-Receipt ----------|
```

For sessions, the first request opens a channel (1 on-chain tx), then all subsequent requests use off-chain vouchers (CPU-only verification):

```
Agent                                   Server
  |                                       |
  |-- Open channel (1 on-chain tx) ------>|
  |-- Voucher #1 (off-chain, ~1ms) ----->|  ← no blockchain
  |-- Voucher #2 (off-chain, ~1ms) ----->|  ← no blockchain
  |-- Voucher #3 (off-chain, ~1ms) ----->|  ← no blockchain
  |-- ... hundreds of requests ...        |
  |                                       |
  |   Server auto-settles at threshold    |
  |   (batch on-chain settlement)         |
```

## mppx Plugin Interface

This package implements the official mppx plugin API (`Method.from` / `Method.toClient` / `Method.toServer`):

```typescript
import { Mppx } from "mppx/server";
import { arcChargeServer, arcSessionServer } from "@mppx-arc/mpp";

const mppx = Mppx.create({
  methods: [
    arcCharge({ recipient: SERVER_ADDRESS, walletClient }),
    arcSession({ payee: SERVER_ADDRESS, escrow: ESCROW, amountPerRequest: 10000n }),
  ],
});
```

Also exports standalone functions for direct use without the mppx framework.

## Deployed Contracts

| Network | Contract | Address |
|---------|----------|---------|
| Arc Testnet | ArcStreamChannel | [`0x805aCAD6064CBfABac71a021c3ab432920925533`](https://testnet.arcscan.app/address/0x805aCAD6064CBfABac71a021c3ab432920925533) |
| Arc Testnet | USDC | `0x3600000000000000000000000000000000000000` |

## Quick Start

### Install

```bash
npm install @mppx-arc/mpp viem mppx
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
      amount: "100000", // $0.10 USDC
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

const res = await fetch("https://api.example.com/data");
const challenge = await res.json();

const credential = await createChargeCredential({
  challenge,
  walletClient,
  publicClient,
  mode: "pull", // gasless for client
});

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
│   │   ├── test/           # 32 tests (incl. fuzz + ERC-1271)
│   │   └── script/Deploy.s.sol
│   └── mpp/                # TypeScript plugin
│       ├── src/
│       │   ├── client/     # Charge + Session client
│       │   ├── server/     # Charge + Session + SSE + HTML
│       │   ├── methods.ts  # mppx Method.from definitions
│       │   └── ...
│       └── test/           # 78 tests (5 suites)
├── examples/
│   ├── server/             # Hono server with charge + session
│   └── agent/              # Autonomous agent client
├── spec/                   # IETF-style formal specification
├── ARCHITECTURE.md         # Security review guide
└── README.md
```

## Tests

```bash
# Solidity (32 tests including fuzz)
cd packages/contracts && forge test -vvv

# TypeScript (78 tests including Arc Testnet integration)
cd packages/mpp && npm test
```

**110 total tests, 0 failures.**

## Comparison with Other MPP Integrations

| Feature | mppx-arc | Monad | Abstract | Avalanche |
|---------|----------|-------|----------|-----------|
| mppx plugin interface | Yes | Yes | Yes | No |
| TypeScript tests | 78 | 36 | 0 | 0 |
| Foundry tests | 32 (incl. fuzz) | 0 | 17 | 22 |
| Charge (push + pull) | Yes | Yes | Pull only | N/A |
| Session channels | Yes | No | Yes | Yes |
| SSE streaming | Yes | No | No | No |
| HTML payment page | Yes | No | No | No |
| Replay protection | Store-based (TTL) | Store-based | No | No |
| Auto-settle batching | Yes | No | No | Yes |
| ERC-1271 wallets | Yes | No | Yes | No |
| IETF-style spec | Yes | Yes | No | No |
| Architecture doc | Yes | Yes | No | No |
| USDC-native chain | Yes | No | No | No |

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
