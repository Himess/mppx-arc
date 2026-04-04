import {
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
  createPublicClient,
  http,
  verifyTypedData,
} from "viem";
import {
  ARC_USDC,
  arcTestnet,
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
} from "../constants.js";
import { ArcStreamChannelAbi } from "../abi.js";
import type { SessionCredentialPayload, SessionReceipt, ArcSessionConfig } from "../types.js";

// ─── Channel Store ───────────────────────────────────────────────────

interface ServerChannelState {
  channelId: Hex;
  payer: Address;
  payee: Address;
  deposit: bigint;
  settled: bigint;
  lastNonce: number;
  lastCumulativeAmount: bigint;
  /** Unsettled voucher amount (for auto-settle threshold) */
  pendingAmount: bigint;
}

const channelStore = new Map<string, ServerChannelState>();

// ─── Verify Session ──────────────────────────────────────────────────

export interface VerifySessionOptions {
  credential: SessionCredentialPayload;
  expectedPayee: Address;
  amountPerRequest: bigint;
  escrow: Address;
  publicClient?: PublicClient;
  walletClient?: WalletClient<Transport, Chain, Account>;
  config?: ArcSessionConfig;
  /** Auto-settle on-chain when pending exceeds this threshold */
  autoSettleThreshold?: bigint;
}

/**
 * Verify a session credential on Arc.
 *
 * Handles channel lifecycle: open, voucher, topUp, close.
 * Voucher verification is CPU-only (sub-ms) — no RPC calls.
 */
export async function verifySession(options: VerifySessionOptions): Promise<SessionReceipt> {
  const { credential, expectedPayee, amountPerRequest, escrow, config } = options;

  const chain = arcTestnet;

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain,
      transport: http(config?.rpcUrl),
    });

  switch (credential.action) {
    case "open":
      return handleOpen({
        credential,
        expectedPayee,
        escrow,
        publicClient,
        chainId: chain.id,
      });

    case "voucher":
      return handleVoucher({
        credential,
        expectedPayee,
        amountPerRequest,
        escrow,
        chainId: chain.id,
        walletClient: options.walletClient,
        autoSettleThreshold: options.autoSettleThreshold,
        publicClient,
      });

    case "topUp":
      return handleTopUp({
        credential,
        escrow,
        publicClient,
        chainId: chain.id,
      });

    case "close":
      return handleClose({
        credential,
        expectedPayee,
        escrow,
        publicClient,
        walletClient: options.walletClient,
        chainId: chain.id,
      });

    default:
      throw new Error(`Unknown session action: ${credential.action}`);
  }
}

// ─── Action Handlers ─────────────────────────────────────────────────

async function handleOpen(options: {
  credential: SessionCredentialPayload;
  expectedPayee: Address;
  escrow: Address;
  publicClient: PublicClient;
  chainId: number;
}): Promise<SessionReceipt> {
  const { credential, expectedPayee, escrow, publicClient, chainId } = options;

  if (!credential.txHash) {
    throw new Error("Open action requires txHash");
  }

  // Verify the open transaction
  const receipt = await publicClient.getTransactionReceipt({ hash: credential.txHash });
  if (receipt.status !== "success") {
    throw new Error("Channel open transaction failed");
  }

  // Read channel state from contract
  const channel = (await publicClient.readContract({
    address: escrow,
    abi: ArcStreamChannelAbi,
    functionName: "getChannel",
    args: [credential.channelId as Hex],
  })) as {
    payer: Address;
    payee: Address;
    deposit: bigint;
    settled: bigint;
    openedAt: bigint;
    closeRequestedAt: bigint;
    closed: boolean;
  };

  if (channel.openedAt === 0n) {
    throw new Error("Channel does not exist");
  }

  if (channel.payee.toLowerCase() !== expectedPayee.toLowerCase()) {
    throw new Error("Channel payee does not match expected payee");
  }

  // Cache channel state
  channelStore.set(credential.channelId!, {
    channelId: credential.channelId as Hex,
    payer: channel.payer,
    payee: channel.payee,
    deposit: channel.deposit,
    settled: channel.settled,
    lastNonce: 0,
    lastCumulativeAmount: 0n,
    pendingAmount: 0n,
  });

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: credential.txHash,
    channelId: credential.channelId as Hex,
    cumulativeAmount: "0",
  };
}

async function handleVoucher(options: {
  credential: SessionCredentialPayload;
  expectedPayee: Address;
  amountPerRequest: bigint;
  escrow: Address;
  chainId: number;
  walletClient?: WalletClient<Transport, Chain, Account>;
  autoSettleThreshold?: bigint;
  publicClient: PublicClient;
}): Promise<SessionReceipt> {
  const {
    credential,
    expectedPayee,
    amountPerRequest,
    escrow,
    chainId,
    walletClient,
    autoSettleThreshold,
    publicClient,
  } = options;

  const channelId = credential.channelId as Hex;
  const cumulativeAmount = BigInt(credential.cumulativeAmount!);
  const nonce = parseInt(credential.nonce!);
  const signature = credential.signature as Hex;

  const state = channelStore.get(channelId);
  if (!state) {
    throw new Error("Channel not found — did you open it first?");
  }

  // Verify nonce is increasing
  if (nonce <= state.lastNonce) {
    throw new Error(`Nonce ${nonce} is not greater than last nonce ${state.lastNonce}`);
  }

  // Verify cumulative amount is non-decreasing
  if (cumulativeAmount < state.lastCumulativeAmount) {
    throw new Error("Cumulative amount cannot decrease");
  }

  // Verify delta matches expected amount per request
  const delta = cumulativeAmount - state.lastCumulativeAmount;
  if (delta < amountPerRequest) {
    throw new Error(
      `Payment delta ${delta} is less than required ${amountPerRequest}`
    );
  }

  // Verify cumulative doesn't exceed deposit
  if (cumulativeAmount > state.deposit) {
    throw new Error("Cumulative amount exceeds channel deposit");
  }

  // Verify voucher signature (CPU-only — no RPC)
  const valid = await verifyTypedData({
    address: state.payer,
    domain: {
      ...STREAM_CHANNEL_EIP712_DOMAIN,
      chainId,
      verifyingContract: escrow,
    },
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: {
      channelId,
      cumulativeAmount,
      nonce: BigInt(nonce),
    },
    signature,
  });

  if (!valid) {
    throw new Error("Invalid voucher signature");
  }

  // Update state
  state.lastNonce = nonce;
  state.lastCumulativeAmount = cumulativeAmount;
  state.pendingAmount += delta;

  // Auto-settle if threshold exceeded
  if (autoSettleThreshold && state.pendingAmount >= autoSettleThreshold && walletClient) {
    await settleOnChain({
      walletClient,
      publicClient,
      escrow,
      channelId,
      cumulativeAmount,
      nonce,
      signature,
    });

    state.settled = cumulativeAmount;
    state.pendingAmount = 0n;
  }

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: `voucher:${channelId}:${nonce}`,
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
  };
}

async function handleTopUp(options: {
  credential: SessionCredentialPayload;
  escrow: Address;
  publicClient: PublicClient;
  chainId: number;
}): Promise<SessionReceipt> {
  const { credential, escrow, publicClient, chainId } = options;
  const channelId = credential.channelId as Hex;

  if (!credential.topUpTxHash) {
    throw new Error("TopUp action requires topUpTxHash");
  }

  const receipt = await publicClient.getTransactionReceipt({
    hash: credential.topUpTxHash,
  });
  if (receipt.status !== "success") {
    throw new Error("TopUp transaction failed");
  }

  // Refresh channel state from chain
  const channel = (await publicClient.readContract({
    address: escrow,
    abi: ArcStreamChannelAbi,
    functionName: "getChannel",
    args: [channelId],
  })) as { deposit: bigint };

  const state = channelStore.get(channelId);
  if (state) {
    state.deposit = channel.deposit;
  }

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: credential.topUpTxHash,
    channelId,
    cumulativeAmount: state?.lastCumulativeAmount.toString() ?? "0",
  };
}

async function handleClose(options: {
  credential: SessionCredentialPayload;
  expectedPayee: Address;
  escrow: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient<Transport, Chain, Account>;
  chainId: number;
}): Promise<SessionReceipt> {
  const { credential, escrow, publicClient, walletClient, chainId } = options;
  const channelId = credential.channelId as Hex;

  if (!walletClient) {
    throw new Error("Close action requires a walletClient");
  }

  const cumulativeAmount = BigInt(credential.cumulativeAmount!);
  const nonce = parseInt(credential.nonce!);
  const signature = credential.signature as Hex;

  // Close channel on-chain
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: ArcStreamChannelAbi,
    functionName: "close",
    args: [channelId, cumulativeAmount, BigInt(nonce), signature],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Remove from cache
  channelStore.delete(channelId);

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: txHash,
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function settleOnChain(options: {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  escrow: Address;
  channelId: Hex;
  cumulativeAmount: bigint;
  nonce: number;
  signature: Hex;
}): Promise<Hash> {
  const { walletClient, publicClient, escrow, channelId, cumulativeAmount, nonce, signature } =
    options;

  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: ArcStreamChannelAbi,
    functionName: "settle",
    args: [channelId, cumulativeAmount, BigInt(nonce), signature],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/**
 * Get cached server channel state.
 */
export function getServerChannelState(channelId: Hex): ServerChannelState | undefined {
  return channelStore.get(channelId);
}

/**
 * Reset session store (for testing).
 */
export function resetSessionStore(): void {
  channelStore.clear();
}
