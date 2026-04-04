# Machine Payments Protocol: Arc Payment Method

**draft-arc-payment-method-00**

## Status

Internet-Draft (informal)

## Abstract

This document defines the "arc" payment method for the Machine Payments Protocol (MPP). The Arc payment method enables machine-to-machine payments using USDC on Circle's Arc blockchain, supporting both one-time charges via ERC-3009 `transferWithAuthorization` and streaming sessions via payment channel escrow contracts.

## 1. Introduction

Circle's Arc is a sovereign L1 blockchain where USDC is the native gas token. This payment method leverages Arc's USDC-native design to provide low-cost, sub-second machine payments without requiring token bridging or external gas tokens.

### 1.1 Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

## 2. Method Registration

- **Method name**: `arc`
- **Intents**: `charge`, `session`
- **Settlement network**: Circle Arc (Chain ID: 5042002 testnet)
- **Settlement token**: USDC (0x3600000000000000000000000000000000000000)

## 3. Charge Intent

The `charge` intent processes one-time USDC payments. Two modes are supported:

### 3.1 Request Parameters

| Parameter   | Type   | Required | Description                          |
|-------------|--------|----------|--------------------------------------|
| `amount`    | string | Yes      | Payment amount in atomic USDC units  |
| `currency`  | string | Yes      | USDC contract address                |
| `recipient` | string | Yes      | Server's receiving address           |
| `chainId`   | number | Yes      | Arc chain ID                         |

### 3.2 Pull Mode (Default)

The client signs an ERC-3009 `TransferWithAuthorization` typed data message. The server broadcasts the transfer on-chain (server pays gas).

**Credential payload:**

| Field         | Type   | Description                              |
|---------------|--------|------------------------------------------|
| `mode`        | string | `"pull"`                                 |
| `signature`   | string | EIP-712 signature (hex)                  |
| `from`        | string | Payer address                            |
| `nonce`       | string | Random bytes32 nonce                     |
| `validAfter`  | string | Authorization validity start (unix)      |
| `validBefore` | string | Authorization validity end (unix)        |

**Flow:**
```
Client                              Server
  |                                    |
  |-- GET /resource ------------------>|
  |<-- 402 + WWW-Authenticate ---------|
  |                                    |
  |  Sign TransferWithAuthorization    |
  |                                    |
  |-- Authorization: Payment <cred> -->|
  |                                    |
  |  Verify signature (ecrecover)      |
  |  Check nonce not used              |
  |  Broadcast transferWithAuth()      |
  |  Wait for receipt                  |
  |                                    |
  |<-- 200 + Payment-Receipt ----------|
```

### 3.3 Push Mode

The client broadcasts an ERC-20 transfer directly (client pays gas).

**Credential payload:**

| Field    | Type   | Description                  |
|----------|--------|------------------------------|
| `mode`   | string | `"push"`                     |
| `txHash` | string | Transaction hash (hex)       |

**Verification:**
1. Server MUST check `txHash` has not been used before (replay protection)
2. Server MUST verify transaction receipt status is `success`
3. Server MUST verify a Transfer event exists with correct recipient and amount

## 4. Session Intent

The `session` intent enables streaming micropayments via an on-chain escrow contract (ArcStreamChannel).

### 4.1 Request Parameters

| Parameter          | Type   | Required | Description                       |
|--------------------|--------|----------|-----------------------------------|
| `payee`            | string | Yes      | Server's receiving address         |
| `escrow`           | string | Yes      | ArcStreamChannel contract address  |
| `chainId`          | number | Yes      | Arc chain ID                       |
| `currency`         | string | Yes      | USDC contract address              |
| `amountPerRequest` | string | Yes      | Cost per request (atomic USDC)     |
| `minDeposit`       | string | Yes      | Minimum escrow deposit             |

### 4.2 Channel Lifecycle

**Open:** Client deposits USDC into escrow → 1 on-chain tx
**Voucher:** Client signs cumulative EIP-712 voucher → 0 on-chain tx (sub-ms)
**TopUp:** Client adds funds to channel → 1 on-chain tx
**Close:** Server settles final voucher and refunds remainder → 1 on-chain tx

### 4.3 Voucher Structure (EIP-712)

```
Voucher(bytes32 channelId, uint128 cumulativeAmount, uint256 nonce)
```

Domain: `{ name: "Arc Stream Channel", version: "1", chainId, verifyingContract: escrow }`

### 4.4 Verification Rules

1. Nonce MUST be strictly increasing
2. Cumulative amount MUST be non-decreasing
3. Delta (current - previous) MUST be >= amountPerRequest
4. Cumulative amount MUST NOT exceed channel deposit
5. Signature MUST be valid for the channel's payer address

### 4.5 Auto-Settlement

Servers MAY configure an auto-settle threshold. When accumulated unsettled voucher amounts exceed this threshold, the server settles on-chain automatically. This batches settlement for efficiency.

## 5. Security Considerations

### 5.1 Replay Protection

- **Charge (pull):** Server MUST track used ERC-3009 nonces in a persistent store. Server SHOULD also verify on-chain `authorizationState()` to detect cross-instance replays.
- **Charge (push):** Server MUST track used transaction hashes.
- **Session:** Strictly increasing nonce per channel prevents replay.

### 5.2 Front-Running

- **Pull mode:** A front-runner could observe the signed authorization in the mempool and submit it themselves. However, the `to` field is fixed to the server's address, so the funds would still reach the correct recipient.
- **Session:** Vouchers are submitted directly to the server, not broadcast to the network.

### 5.3 Recall Protection

The ArcStreamChannel contract includes a 15-minute grace period for payer-initiated close requests. This gives the server time to settle any outstanding vouchers before the payer can withdraw.

### 5.4 Smart Wallet Compatibility

The escrow contract supports ERC-1271 signature verification, allowing smart contract wallets to be payers.

## 6. Receipt

Receipts follow the standard MPP receipt format:

```json
{
  "method": "arc",
  "status": "success",
  "timestamp": "2026-04-04T20:00:00Z",
  "reference": "0x..."
}
```

## 7. References

- [MPP Specification](https://paymentauth.org)
- [IETF draft-ryan-httpauth-payment-01](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/)
- [ERC-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [EIP-712: Typed Structured Data Hashing and Signing](https://eips.ethereum.org/EIPS/eip-712)
- [Circle Arc Documentation](https://developers.circle.com)

## Author

Himess (github.com/Himess)
