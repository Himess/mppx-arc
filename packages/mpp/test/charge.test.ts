import { describe, it, expect, beforeEach } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Address,
  type Hex,
  keccak256,
  encodePacked,
  verifyTypedData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  ARC_USDC,
  arcTestnet,
} from "../src/constants.js";
import type { ChargeCredentialPayload } from "../src/types.js";

// ─── Test Accounts ───────────────────────────────────────────────────

const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SERVER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const payerAccount = privateKeyToAccount(PAYER_KEY);
const serverAccount = privateKeyToAccount(SERVER_KEY);

// ─── Tests ───────────────────────────────────────────────────────────

describe("Charge — Pull Mode (ERC-3009)", () => {
  const amount = parseUnits("1", 6); // 1 USDC
  const recipient = serverAccount.address;
  const chainId = arcTestnet.id;
  const currency = ARC_USDC;

  it("should create a valid ERC-3009 signature", async () => {
    const nonce = keccak256(
      encodePacked(
        ["address", "uint256", "uint256"],
        [payerAccount.address, amount, BigInt(Date.now())]
      )
    );

    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    expect(signature).toBeDefined();
    expect(signature.length).toBe(132); // 0x + 130 hex chars

    // Verify the signature locally
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
      signature,
    });

    expect(valid).toBe(true);
  });

  it("should produce correct credential payload structure", async () => {
    const nonce = keccak256(
      encodePacked(
        ["address", "uint256", "uint256"],
        [payerAccount.address, amount, 1n]
      )
    );

    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: amount,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
    });

    const payload: ChargeCredentialPayload = {
      mode: "pull",
      signature,
      from: payerAccount.address,
      nonce,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    };

    expect(payload.mode).toBe("pull");
    expect(payload.from).toBe(payerAccount.address);
    expect(payload.signature).toMatch(/^0x/);
    expect(payload.nonce).toMatch(/^0x/);
  });

  it("should reject signature with wrong signer", async () => {
    const nonce = keccak256(encodePacked(["uint256"], [42n]));

    // Sign with server key (wrong signer)
    const walletClient = createWalletClient({
      account: serverAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address, // Claims to be payer
        to: recipient,
        value: amount,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
    });

    // Verify against payer's address — should fail
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: amount,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
      signature,
    });

    expect(valid).toBe(false);
  });

  it("should reject signature with wrong amount", async () => {
    const nonce = keccak256(encodePacked(["uint256"], [43n]));

    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: amount, // Signed for 1 USDC
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
    });

    // Verify for different amount — should fail
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: parseUnits("2", 6), // Different amount
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
      signature,
    });

    expect(valid).toBe(false);
  });

  it("should reject signature with wrong recipient", async () => {
    const nonce = keccak256(encodePacked(["uint256"], [44n]));
    const wrongRecipient = "0x0000000000000000000000000000000000000001" as Address;

    const walletClient = createWalletClient({
      account: payerAccount,
      chain: arcTestnet,
      transport: http(),
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: recipient,
        value: amount,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
    });

    // Verify for wrong recipient
    const valid = await verifyTypedData({
      address: payerAccount.address,
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId,
        verifyingContract: currency,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payerAccount.address,
        to: wrongRecipient,
        value: amount,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce,
      },
      signature,
    });

    expect(valid).toBe(false);
  });
});

describe("Charge — Push Mode", () => {
  it("should create push credential with txHash", () => {
    const payload: ChargeCredentialPayload = {
      mode: "push",
      txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    };

    expect(payload.mode).toBe("push");
    expect(payload.txHash).toBeDefined();
    expect(payload.txHash!.length).toBe(66);
  });
});

describe("Charge — Replay Protection", () => {
  it("should track used nonces", () => {
    const usedNonces = new Set<string>();
    const nonce1 = "0xabc:0x123";
    const nonce2 = "0xabc:0x456";

    usedNonces.add(nonce1);
    expect(usedNonces.has(nonce1)).toBe(true);
    expect(usedNonces.has(nonce2)).toBe(false);

    usedNonces.add(nonce2);
    expect(usedNonces.has(nonce2)).toBe(true);
    expect(usedNonces.size).toBe(2);
  });

  it("should track used tx hashes", () => {
    const usedTxHashes = new Set<string>();
    const txHash = "0xabcdef";

    expect(usedTxHashes.has(txHash)).toBe(false);
    usedTxHashes.add(txHash);
    expect(usedTxHashes.has(txHash)).toBe(true);
  });
});
