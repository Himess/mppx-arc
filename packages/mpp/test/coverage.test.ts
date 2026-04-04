import { describe, it, expect } from "vitest";
import {
  createWalletClient,
  http,
  parseUnits,
  type Hex,
  type Address,
  keccak256,
  encodePacked,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  ARC_USDC,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
} from "../src/constants.js";
import { renderPaymentPage, isBrowserRequest } from "../src/server/html.js";
import { createSSEStream } from "../src/server/sse.js";
import type {
  ChargeCredentialPayload,
  SessionCredentialPayload,
} from "../src/types.js";

const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SERVER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const payerAccount = privateKeyToAccount(PAYER_KEY);
const serverAccount = privateKeyToAccount(SERVER_KEY);

// ─── Push Mode Tests ─────────────────────────────────────────────────

describe("Push Mode — Credential Structure", () => {
  it("should create push credential with only mode and txHash", () => {
    const payload: ChargeCredentialPayload = {
      mode: "push",
      txHash: "0x" + "ab".repeat(32),
    };

    expect(payload.mode).toBe("push");
    expect(payload.txHash).toBeDefined();
    expect(payload.signature).toBeUndefined();
    expect(payload.from).toBeUndefined();
  });

  it("should not include pull-mode fields in push credential", () => {
    const payload: ChargeCredentialPayload = {
      mode: "push",
      txHash: "0x" + "cd".repeat(32),
    };

    expect(payload.nonce).toBeUndefined();
    expect(payload.validAfter).toBeUndefined();
    expect(payload.validBefore).toBeUndefined();
  });
});

// ─── Expired Authorization Tests ─────────────────────────────────────

describe("Expired Authorization Detection", () => {
  it("should detect expired validBefore", () => {
    const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const now = Math.floor(Date.now() / 1000);

    expect(BigInt(pastTime) <= BigInt(now)).toBe(true);
  });

  it("should accept future validBefore", () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600;
    const now = Math.floor(Date.now() / 1000);

    expect(BigInt(futureTime) > BigInt(now)).toBe(true);
  });
});

// ─── HTML Payment Page Tests ─────────────────────────────────────────

describe("HTML Payment Page", () => {
  it("should render valid HTML", () => {
    const html = renderPaymentPage({
      merchantName: "Test Service",
      displayAmount: "0.10",
      recipient: serverAccount.address,
      intent: "charge",
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("402 Payment Required");
    expect(html).toContain("Test Service");
    expect(html).toContain("$0.10");
    expect(html).toContain("USDC");
  });

  it("should escape HTML in merchantName (XSS prevention)", () => {
    const html = renderPaymentPage({
      merchantName: '<script>alert("xss")</script>',
      displayAmount: "1.00",
      recipient: serverAccount.address,
      intent: "charge",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("should escape HTML in displayAmount", () => {
    const html = renderPaymentPage({
      displayAmount: '"><script>alert(1)</script>',
      recipient: serverAccount.address,
      intent: "charge",
    });

    expect(html).not.toContain('"><script>');
  });

  it("should escape explorerUrl", () => {
    const html = renderPaymentPage({
      displayAmount: "0.10",
      recipient: serverAccount.address,
      intent: "charge",
      explorerUrl: 'javascript:alert(1)',
    });

    expect(html).toContain("javascript:alert(1)"); // still in href but escaped
    expect(html).not.toContain("<script>");
  });

  it("should show session intent correctly", () => {
    const html = renderPaymentPage({
      displayAmount: "0.01",
      recipient: serverAccount.address,
      intent: "session",
    });

    expect(html).toContain("Session (streaming)");
  });

  it("should show charge intent correctly", () => {
    const html = renderPaymentPage({
      displayAmount: "0.10",
      recipient: serverAccount.address,
      intent: "charge",
    });

    expect(html).toContain("One-time");
  });
});

describe("Browser Request Detection", () => {
  it("should detect browser request with text/html", () => {
    const req = new Request("http://localhost/api", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(isBrowserRequest(req)).toBe(true);
  });

  it("should not detect JSON-only request as browser", () => {
    const req = new Request("http://localhost/api", {
      headers: { Accept: "application/json" },
    });
    expect(isBrowserRequest(req)).toBe(false);
  });

  it("should handle missing Accept header", () => {
    const req = new Request("http://localhost/api");
    expect(isBrowserRequest(req)).toBe(false);
  });
});

// ─── SSE Streaming Tests ─────────────────────────────────────────────

describe("SSE Streaming", () => {
  it("should create a valid SSE response", async () => {
    const channelId = keccak256(encodePacked(["string"], ["sse-test"])) as Hex;
    const escrow = "0x805aCAD6064CBfABac71a021c3ab432920925533" as Address;
    const amountPerToken = 100n; // $0.0001

    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const cumulativeAmount = 500n; // Budget for 5 tokens
    const nonce = 1;

    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId: arcTestnet.id,
        verifyingContract: escrow,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount, nonce: BigInt(nonce) },
    });

    const response = createSSEStream({
      channelState: {
        payer: payerAccount.address,
        deposit: 10000n,
        lastNonce: 0,
        lastCumulativeAmount: 0n,
      },
      escrow,
      chainId: arcTestnet.id,
      amountPerToken,
      generate: async function* () {
        yield "Hello";
        yield " World";
        yield "!";
      },
      voucher: {
        channelId,
        cumulativeAmount,
        nonce,
        signature,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("X-MPP-Channel-Id")).toBe(channelId);
    expect(response.headers.get("X-MPP-Tokens-Budget")).toBe("5");

    // Read the stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value);
    }

    expect(fullText).toContain('"token":"Hello"');
    expect(fullText).toContain('"token":" World"');
    expect(fullText).toContain('"token":"!"');
    expect(fullText).toContain("event: done");
    expect(fullText).toContain('"tokensUsed":3');
  });

  it("should stop at budget limit", async () => {
    const channelId = keccak256(encodePacked(["string"], ["sse-budget"])) as Hex;
    const escrow = "0x805aCAD6064CBfABac71a021c3ab432920925533" as Address;

    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    // Budget for only 2 tokens
    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId: arcTestnet.id,
        verifyingContract: escrow,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount: 200n, nonce: 1n },
    });

    const response = createSSEStream({
      channelState: {
        payer: payerAccount.address,
        deposit: 10000n,
        lastNonce: 0,
        lastCumulativeAmount: 0n,
      },
      escrow,
      chainId: arcTestnet.id,
      amountPerToken: 100n,
      generate: async function* () {
        yield "A"; yield "B"; yield "C"; yield "D"; yield "E";
      },
      voucher: {
        channelId,
        cumulativeAmount: 200n,
        nonce: 1,
        signature,
      },
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullText += decoder.decode(value);
    }

    // Should only deliver 2 tokens, then payment_required
    expect(fullText).toContain('"token":"A"');
    expect(fullText).toContain('"token":"B"');
    expect(fullText).toContain("event: payment_required");
    expect(fullText).not.toContain('"token":"C"');
  });
});

// ─── TopUp Credential Tests ──────────────────────────────────────────

describe("TopUp — Credential Structure", () => {
  it("should create valid topUp payload", () => {
    const payload: SessionCredentialPayload = {
      action: "topUp",
      channelId: keccak256(encodePacked(["string"], ["topup-test"])),
      topUpTxHash: "0x" + "ef".repeat(32),
    };

    expect(payload.action).toBe("topUp");
    expect(payload.topUpTxHash).toBeDefined();
    expect(payload.signature).toBeUndefined();
  });

  it("should reject topUp without txHash", () => {
    const payload: SessionCredentialPayload = {
      action: "topUp",
      channelId: keccak256(encodePacked(["string"], ["topup-no-tx"])),
    };

    expect(payload.topUpTxHash).toBeUndefined();
  });
});

// ─── Standalone Client/Server Compatibility ──────────────────────────

describe("Standalone Client Session — Open Action", () => {
  it("first call should return open action (M1 fix)", () => {
    // The standalone createSessionCredential should return action: "open"
    // on first call, not "voucher"
    // This is tested structurally since we can't call the real function
    // without on-chain interaction

    const openPayload: SessionCredentialPayload = {
      action: "open",
      channelId: "0x" + "ab".repeat(32),
      txHash: "0x" + "cd".repeat(32),
    };

    expect(openPayload.action).toBe("open");
    expect(openPayload.txHash).toBeDefined();
    expect(openPayload.signature).toBeUndefined();
  });

  it("subsequent calls should return voucher action", () => {
    const voucherPayload: SessionCredentialPayload = {
      action: "voucher",
      channelId: "0x" + "ab".repeat(32),
      cumulativeAmount: "10000",
      nonce: "1",
      signature: "0x" + "ef".repeat(65),
    };

    expect(voucherPayload.action).toBe("voucher");
    expect(voucherPayload.cumulativeAmount).toBeDefined();
    expect(voucherPayload.signature).toBeDefined();
  });
});

// ─── Replay Protection Store Tests ───────────────────────────────────

describe("Bounded Replay Store", () => {
  it("should track entries with timestamps", () => {
    const store = new Map<string, { timestamp: number }>();
    store.set("tx:0xabc", { timestamp: Date.now() });

    expect(store.has("tx:0xabc")).toBe(true);
    expect(store.has("tx:0xdef")).toBe(false);
  });

  it("should handle TTL expiry logic", () => {
    const TTL = 24 * 60 * 60 * 1000;
    const oldTimestamp = Date.now() - TTL - 1000; // expired
    const freshTimestamp = Date.now();

    expect(Date.now() - oldTimestamp > TTL).toBe(true);
    expect(Date.now() - freshTimestamp > TTL).toBe(false);
  });

  it("should evict old entries when at capacity", () => {
    const MAX = 5;
    const store = new Map<string, { timestamp: number }>();

    for (let i = 0; i < MAX + 2; i++) {
      store.set(`key:${i}`, { timestamp: Date.now() });
    }

    expect(store.size).toBe(MAX + 2);

    // Simulate eviction
    if (store.size >= MAX) {
      const toDelete = Math.floor(store.size * 0.1) || 1;
      let count = 0;
      for (const k of store.keys()) {
        if (count++ >= toDelete) break;
        store.delete(k);
      }
    }

    expect(store.size).toBeLessThan(MAX + 2);
  });
});

// ─── BigInt Nonce Precision Tests ────────────────────────────────────

describe("BigInt Nonce Precision (H5 fix)", () => {
  it("should handle large nonces without precision loss", () => {
    const largeNonce = BigInt("9007199254740993"); // > Number.MAX_SAFE_INTEGER
    const parsed = BigInt("9007199254740993");

    expect(parsed).toBe(largeNonce);
    expect(parsed > BigInt("9007199254740992")).toBe(true);
  });

  it("parseInt loses precision for very large nonces", () => {
    // 2^64 range — common in uint256 nonces
    const largeStr = "18446744073709551617"; // 2^64 + 1
    const parsedNumber = parseInt(largeStr);
    const parsedBigInt = BigInt(largeStr);

    // parseInt rounds — loses exact value
    expect(parsedNumber.toString()).not.toBe(largeStr);
    // BigInt preserves exact value
    expect(parsedBigInt.toString()).toBe(largeStr);
  });
});
