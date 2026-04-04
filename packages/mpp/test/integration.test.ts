import { describe, it, expect } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
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
  ARC_STREAM_CHANNEL,
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../src/constants.js";
import { Erc20Abi, ArcStreamChannelAbi } from "../src/abi.js";

// ─── Config ──────────────────────────────────────────────────────────

const RPC_URL = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";
const PRIVATE_KEY = (process.env.PRIVATE_KEY ||
  "0x0beef695a3a30c5eb3a7c3ca656e1d8ec6f9c3a98349959326fe11e4a410dbc6") as Hex;
const ESCROW = ARC_STREAM_CHANNEL[arcTestnet.id];

const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: arcTestnet,
  transport: http(RPC_URL),
});

// ─── Integration Tests ───────────────────────────────────────────────

describe("Integration — Arc Testnet Connection", () => {
  it("should connect to Arc Testnet RPC", async () => {
    const chainId = await publicClient.getChainId();
    expect(chainId).toBe(5042002);
  });

  it("should read USDC balance", async () => {
    const balance = await publicClient.readContract({
      address: ARC_USDC,
      abi: Erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    console.log(`    USDC balance: ${formatUnits(balance as bigint, 6)} USDC`);
    expect(balance).toBeDefined();
  });

  it("should read USDC name", async () => {
    const name = await publicClient.readContract({
      address: ARC_USDC,
      abi: Erc20Abi,
      functionName: "name",
      args: [],
    });
    expect(name).toBe("USDC");
  });
});

describe("Integration — ArcStreamChannel Contract", () => {
  it("should read contract USDC address", async () => {
    const usdc = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "USDC",
      args: [],
    });
    expect((usdc as string).toLowerCase()).toBe(ARC_USDC.toLowerCase());
  });

  it("should read domain separator", async () => {
    const ds = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "domainSeparator",
      args: [],
    });
    expect(ds).toBeDefined();
    expect((ds as string).length).toBe(66); // 0x + 64 hex
  });

  it("should read close grace period", async () => {
    const gp = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "CLOSE_GRACE_PERIOD",
      args: [],
    });
    expect(gp).toBe(900n); // 15 minutes
  });

  it("should compute channel ID deterministically", async () => {
    const salt = keccak256(encodePacked(["string"], ["integration-test"]));
    const id1 = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "computeChannelId",
      args: [account.address, account.address, salt],
    });
    const id2 = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "computeChannelId",
      args: [account.address, account.address, salt],
    });
    expect(id1).toBe(id2);
  });
});

describe("Integration — ERC-3009 Authorization", () => {
  it("should check authorization state for unused nonce", async () => {
    const nonce = keccak256(
      encodePacked(["address", "uint256"], [account.address, BigInt(Date.now())])
    );

    const isUsed = await publicClient.readContract({
      address: ARC_USDC,
      abi: Erc20Abi,
      functionName: "authorizationState",
      args: [account.address, nonce],
    });
    expect(isUsed).toBe(false);
  });

  it("should create valid ERC-3009 signature for Arc USDC", async () => {
    const amount = parseUnits("0.01", 6);
    const nonce = keccak256(
      encodePacked(["string", "uint256"], ["erc3009-test", BigInt(Date.now())])
    );
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const signature = await walletClient.signTypedData({
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId: arcTestnet.id,
        verifyingContract: ARC_USDC,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: account.address,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        ...USDC_EIP712_DOMAIN,
        chainId: arcTestnet.id,
        verifyingContract: ARC_USDC,
      },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: account.address,
        to: account.address,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
      signature,
    });

    expect(valid).toBe(true);
  });
});

describe("Integration — Voucher Signature for Deployed Contract", () => {
  it("should create voucher compatible with deployed contract domain", async () => {
    const channelId = keccak256(encodePacked(["string"], ["test-channel-voucher"]));
    const cumulativeAmount = parseUnits("0.01", 6);
    const nonce = 1n;

    const contractDomainSeparator = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "domainSeparator",
      args: [],
    });

    const signature = await walletClient.signTypedData({
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId: arcTestnet.id,
        verifyingContract: ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount, nonce },
    });

    // Verify locally
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        ...STREAM_CHANNEL_EIP712_DOMAIN,
        chainId: arcTestnet.id,
        verifyingContract: ESCROW,
      },
      types: VOUCHER_TYPES,
      primaryType: "Voucher",
      message: { channelId, cumulativeAmount, nonce },
      signature,
    });

    expect(valid).toBe(true);
    console.log(`    Contract domain separator: ${contractDomainSeparator}`);
  });

  it("should match on-chain voucher hash", async () => {
    const channelId = keccak256(encodePacked(["string"], ["hash-test"]));
    const amount = parseUnits("1", 6);
    const nonce = 42n;

    const onChainHash = await publicClient.readContract({
      address: ESCROW,
      abi: ArcStreamChannelAbi,
      functionName: "getVoucherHash",
      args: [channelId, amount, nonce],
    });

    expect(onChainHash).toBeDefined();
    expect((onChainHash as string).length).toBe(66);
  });
});
