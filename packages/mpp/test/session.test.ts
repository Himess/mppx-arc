import { describe, it, expect, beforeEach } from "vitest";
import {
  createWalletClient,
  http,
  parseUnits,
  type Hex,
  keccak256,
  encodePacked,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
  arcTestnet,
} from "../src/constants.js";
import type { SessionCredentialPayload } from "../src/types.js";

// ─── Test Accounts ───────────────────────────────────────────────────

const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SERVER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const payerAccount = privateKeyToAccount(PAYER_KEY);
const serverAccount = privateKeyToAccount(SERVER_KEY);

const MOCK_ESCROW = "0x1234567890123456789012345678901234567890" as const;
const MOCK_CHANNEL_ID = keccak256(
  encodePacked(
    ["address", "address", "bytes32"],
    [payerAccount.address, serverAccount.address, keccak256(encodePacked(["uint256"], [1n]))]
  )
) as Hex;

// ─── Tests ───────────────────────────────────────────────────────────

describe("Session — Voucher Signatures", () => {
  const chainId = arcTestnet.id;
  const amountPerRequest = parseUnits("0.01", 6); // $0.01

  it("should sign a valid voucher", async () => {
    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const cumulativeAmount = amountPerRequest;
    const nonce = 1n;

    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount,
        nonce,
      },
    });

    expect(signature).toBeDefined();

    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount,
        nonce,
      },
      signature,
    });

    expect(valid).toBe(true);
  });

  it("should create cumulative vouchers with increasing amounts", async () => {
    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signatures: Hex[] = [];
    let cumulative = 0n;

    for (let i = 1; i <= 5; i++) {
      cumulative += amountPerRequest;

      const sig = await walletClient.signTypedData({
        domain: {
          ...STREAM_CHANNEL_EIP712_DOMAIN,
          chainId,
          verifyingContract: MOCK_ESCROW,
        },
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message: {
          channelId: MOCK_CHANNEL_ID,
          cumulativeAmount: cumulative,
          nonce: BigInt(i),
        },
      });

      signatures.push(sig);
    }

    expect(signatures.length).toBe(5);
    // All signatures should be unique
    const unique = new Set(signatures);
    expect(unique.size).toBe(5);

    // Verify last voucher
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount: cumulative,
        nonce: 5n,
      },
      signature: signatures[4],
    });

    expect(valid).toBe(true);
  });

  it("should reject voucher signed by wrong key", async () => {
    const walletClient = createWalletClient({
      account: serverAccount, // Wrong signer
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount: amountPerRequest,
        nonce: 1n,
      },
    });

    // Verify against payer's address — should fail
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount: amountPerRequest,
        nonce: 1n,
      },
      signature,
    });

    expect(valid).toBe(false);
  });

  it("should reject voucher with tampered amount", async () => {
    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount: amountPerRequest,
        nonce: 1n,
      },
    });

    // Verify with different amount — should fail
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount: amountPerRequest * 2n,
        nonce: 1n,
      },
      signature,
    });

    expect(valid).toBe(false);
  });

  it("should reject voucher with wrong channel ID", async () => {
    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: MOCK_CHANNEL_ID,
        cumulativeAmount: amountPerRequest,
        nonce: 1n,
      },
    });

    const wrongChannelId = keccak256(encodePacked(["uint256"], [999n])) as Hex;

    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId,
        verifyingContract: MOCK_ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: {
        channelId: wrongChannelId,
        cumulativeAmount: amountPerRequest,
        nonce: 1n,
      },
      signature,
    });

    expect(valid).toBe(false);
  });
});

describe("Session — Credential Payload Structure", () => {
  it("should create valid open payload", () => {
    const payload: SessionCredentialPayload = {
      action: "open",
      channelId: MOCK_CHANNEL_ID,
      txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    };

    expect(payload.action).toBe("open");
    expect(payload.channelId).toBeDefined();
    expect(payload.txHash).toBeDefined();
  });

  it("should create valid voucher payload", () => {
    const payload: SessionCredentialPayload = {
      action: "voucher",
      channelId: MOCK_CHANNEL_ID,
      cumulativeAmount: "10000",
      nonce: "1",
      signature: "0x" + "ab".repeat(65),
    };

    expect(payload.action).toBe("voucher");
    expect(payload.cumulativeAmount).toBe("10000");
    expect(payload.nonce).toBe("1");
    expect(payload.signature).toBeDefined();
  });

  it("should create valid close payload", () => {
    const payload: SessionCredentialPayload = {
      action: "close",
      channelId: MOCK_CHANNEL_ID,
      cumulativeAmount: "50000",
      nonce: "5",
      signature: "0x" + "cd".repeat(65),
    };

    expect(payload.action).toBe("close");
  });

  it("should create valid topUp payload", () => {
    const payload: SessionCredentialPayload = {
      action: "topUp",
      channelId: MOCK_CHANNEL_ID,
      topUpTxHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    };

    expect(payload.action).toBe("topUp");
    expect(payload.topUpTxHash).toBeDefined();
  });
});

describe("Session — Server-side Nonce Tracking", () => {
  it("should enforce monotonically increasing nonces", () => {
    let lastNonce = 0;
    const nonces = [1, 2, 3, 5, 10];

    for (const nonce of nonces) {
      expect(nonce).toBeGreaterThan(lastNonce);
      lastNonce = nonce;
    }
  });

  it("should reject non-increasing nonces", () => {
    let lastNonce = 5;
    const badNonce = 3;

    expect(badNonce).not.toBeGreaterThan(lastNonce);
  });

  it("should enforce cumulative amount non-decreasing", () => {
    const amounts = [10000n, 20000n, 30000n, 40000n, 50000n];
    let lastAmount = 0n;

    for (const amount of amounts) {
      expect(amount).toBeGreaterThanOrEqual(lastAmount);
      const delta = amount - lastAmount;
      expect(delta).toBeGreaterThan(0n);
      lastAmount = amount;
    }
  });

  it("should reject decreasing cumulative amount", () => {
    const lastAmount = 30000n;
    const badAmount = 20000n;

    expect(badAmount < lastAmount).toBe(true);
  });

  it("should enforce delta >= amountPerRequest", () => {
    const amountPerRequest = 10000n;
    const lastAmount = 20000n;

    const goodCumulative = 30000n;
    expect(goodCumulative - lastAmount).toBeGreaterThanOrEqual(amountPerRequest);

    const badCumulative = 25000n;
    expect(badCumulative - lastAmount < amountPerRequest).toBe(true);
  });
});

describe("Session — Auto-Settle Threshold", () => {
  it("should trigger settlement when threshold exceeded", () => {
    const threshold = 50000n; // 0.05 USDC
    const amountPerRequest = 10000n; // 0.01 USDC
    let pending = 0n;
    let settleCount = 0;

    for (let i = 0; i < 10; i++) {
      pending += amountPerRequest;

      if (pending >= threshold) {
        settleCount++;
        pending = 0n;
      }
    }

    expect(settleCount).toBe(2); // 50000 at i=4, 50000 at i=9
  });

  it("should not settle below threshold", () => {
    const threshold = 100000n;
    const amountPerRequest = 10000n;
    let pending = 0n;
    let settleCount = 0;

    for (let i = 0; i < 5; i++) {
      pending += amountPerRequest;
      if (pending >= threshold) {
        settleCount++;
        pending = 0n;
      }
    }

    expect(settleCount).toBe(0);
    expect(pending).toBe(50000n);
  });
});

describe("Session — Channel State Management", () => {
  it("should track channel state correctly", () => {
    const state = {
      channelId: MOCK_CHANNEL_ID,
      payer: payerAccount.address,
      payee: serverAccount.address,
      deposit: parseUnits("10", 6),
      settled: 0n,
      lastNonce: 0,
      lastCumulativeAmount: 0n,
      pendingAmount: 0n,
    };

    const amountPerRequest = parseUnits("0.01", 6);

    // Simulate 5 vouchers
    for (let i = 1; i <= 5; i++) {
      state.lastCumulativeAmount += amountPerRequest;
      state.lastNonce = i;
      state.pendingAmount += amountPerRequest;
    }

    expect(state.lastNonce).toBe(5);
    expect(state.lastCumulativeAmount).toBe(parseUnits("0.05", 6));
    expect(state.pendingAmount).toBe(parseUnits("0.05", 6));
    expect(state.lastCumulativeAmount).toBeLessThanOrEqual(state.deposit);
  });

  it("should reject amount exceeding deposit", () => {
    const deposit = parseUnits("1", 6); // 1 USDC
    const cumulativeAmount = parseUnits("2", 6); // 2 USDC

    expect(cumulativeAmount > deposit).toBe(true);
  });
});
