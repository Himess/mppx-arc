# Architecture

Security review guide for `mppx-arc` — MPP payment method for Circle's Arc chain.

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED                                │
│                                                                 │
│  ┌──────────┐         HTTP 402 Flow           ┌──────────┐     │
│  │  Agent /  │ ──────────────────────────────► │  Server  │     │
│  │  Client   │ ◄────────────────────────────── │          │     │
│  └──────────┘                                  └──────────┘     │
│       │                                             │           │
│  B1 ──┼─────────────────────────────────────────────┼── B1      │
│       │                                             │           │
│  ┌──────────┐                                  ┌──────────┐     │
│  │  viem    │                                  │  viem    │     │
│  │  wallet  │                                  │  wallet  │     │
│  └──────────┘                                  └──────────┘     │
│       │                                             │           │
│  B2 ──┼─────────────────────────────────────────────┼── B2      │
│       │                                             │           │
│       ▼                                             ▼           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    Arc Testnet RPC                        │   │
│  │  USDC: 0x3600...   ArcStreamChannel: 0x805a...           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                          TRUSTED                                │
└─────────────────────────────────────────────────────────────────┘
```

**B1 — HTTP boundary:** Client sends credentials, server verifies. All data crossing this boundary is untrusted and validated via Zod schemas + cryptographic verification.

**B2 — RPC boundary:** Both client and server interact with Arc chain via RPC. Transaction receipts and on-chain state are trusted (blockchain consensus).

## Module Inventory

| Module | Lines | Purpose | Trust Level |
|--------|-------|---------|-------------|
| `src/methods.ts` | 60 | Method.from() definitions, Zod schemas | Schema validation |
| `src/client/charge.ts` | 110 | ERC-3009 signing, push transfer | Runs on client |
| `src/client/session.ts` | 140 | Channel open, voucher signing | Runs on client |
| `src/client/methods.ts` | 175 | mppx plugin client wrappers | Runs on client |
| `src/server/charge.ts` | 180 | Payment verification (push+pull) | **Security critical** |
| `src/server/session.ts` | 250 | Session lifecycle verification | **Security critical** |
| `src/server/methods.ts` | 280 | mppx plugin server wrappers | **Security critical** |
| `src/server/sse.ts` | 120 | SSE streaming with voucher gating | Medium |
| `src/server/html.ts` | 150 | Browser payment page | Low risk (display) |
| `src/constants.ts` | 55 | Chain config, addresses, EIP-712 | Hardcoded constants |
| `src/abi.ts` | 220 | Contract ABIs | Hardcoded constants |
| `src/types.ts` | 115 | TypeScript type definitions | No runtime effect |
| `ArcStreamChannel.sol` | 240 | Escrow contract | **Security critical** |

## Data Flow

### Charge (Pull Mode)

```
1. Client → Server: GET /resource
2. Server → Client: 402 + WWW-Authenticate (challenge)
3. Client: Sign ERC-3009 TransferWithAuthorization
4. Client → Server: Authorization: Payment <credential>
5. Server: Validate Zod schema
6. Server: Check nonce in Store (replay protection)
7. Server: Check nonce on-chain (authorizationState)
8. Server: Verify EIP-712 signature (ecrecover)
9. Server: Broadcast transferWithAuthorization (server pays gas)
10. Server: Wait for tx receipt
11. Server: Store nonce as used
12. Server → Client: 200 + Payment-Receipt
```

### Session (Voucher)

```
1. Client → Server: GET /resource (first time)
2. Server → Client: 402 + WWW-Authenticate (session challenge)
3. Client: Approve USDC → escrow
4. Client: Call escrow.open() (on-chain)
5. Client → Server: Authorization: Payment (action=open, txHash)
6. Server: Verify open tx receipt, read channel state
7. Server → Client: 204 (channel confirmed)

--- subsequent requests (sub-ms, no on-chain tx) ---

8. Client: Sign EIP-712 voucher (cumulative)
9. Client → Server: Authorization: Payment (action=voucher)
10. Server: Verify nonce increasing
11. Server: Verify cumulative amount non-decreasing
12. Server: Verify delta >= amountPerRequest
13. Server: Verify amount <= deposit
14. Server: Verify EIP-712 signature (CPU only)
15. Server → Client: 200 + Payment-Receipt

--- auto-settle (periodic) ---

16. Server: pending >= threshold → call escrow.settle() on-chain
```

## Hardcoded Constants

| Constant | Value | Source |
|----------|-------|--------|
| Arc Testnet Chain ID | 5042002 | Circle docs |
| USDC address | 0x3600...0000 | Arc precompile |
| ArcStreamChannel | 0x805aCAD6... | Deployed via forge |
| Close grace period | 15 minutes | Contract constant |
| USDC EIP-712 name | "USDC" | On-chain name() |
| USDC EIP-712 version | "2" | FiatTokenV2_2 |
| Channel EIP-712 name | "Arc Stream Channel" | Contract constructor |
| Channel EIP-712 version | "1" | Contract constructor |

## Known Limitations

1. **In-memory channel state:** Session channel state is stored in a Map. Server restart loses state. Production should use mppx Store (Redis/Upstash/Cloudflare KV).

2. **Single-server sessions:** Channel state is not shared across server instances. Load-balanced deployments need shared state via Store.

3. **No refund mechanism for charge:** Once a charge payment is settled, there is no protocol-level refund. This is by design for machine payments.

4. **USDC-only:** This payment method only supports USDC on Arc. No other tokens.

5. **Testnet only:** Arc mainnet is not yet live. Chain IDs and contract addresses will change.

## DoS Risk Analysis

| Vector | Mitigation |
|--------|------------|
| Flood 402 requests | Standard rate limiting (not MPP's concern) |
| Submit used nonces | Store lookup + on-chain check (fast reject) |
| Submit invalid signatures | ecrecover is CPU-only, ~1ms |
| Open many channels | Requires real USDC deposit (economic cost) |
| Submit vouchers exceeding deposit | Rejected by cumulative <= deposit check |
| Front-run pull mode auth | Funds still go to correct recipient |

## Dependency Analysis

| Dependency | Version | Purpose | Risk |
|------------|---------|---------|------|
| `viem` | ^2.27.0 | EVM interactions, signing, ABI encoding | Well-audited, 20K+ stars |
| `mppx` | ^0.5.5 | MPP framework (Method, Challenge, Credential, Store) | Official SDK by wevm |
| `@openzeppelin/contracts` | v5.6.1 | ERC20, ECDSA, EIP712, ReentrancyGuard | Industry standard |

No custom cryptography. All signing uses EIP-712 via viem. All on-chain verification uses OpenZeppelin's SignatureChecker.
