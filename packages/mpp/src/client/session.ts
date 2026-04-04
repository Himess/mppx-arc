import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  http,
  keccak256,
  encodePacked,
} from "viem";
import { ARC_USDC, arcTestnet, STREAM_CHANNEL_EIP712_DOMAIN, VOUCHER_TYPES } from "../constants.js";
import { ArcStreamChannelAbi, Erc20Abi } from "../abi.js";
import type { SessionCredentialPayload, ChannelState, ArcSessionConfig } from "../types.js";

export interface SessionChallenge {
  payee: Address;
  escrow: Address;
  chainId: number;
  currency: Address;
  amountPerRequest: string;
  minDeposit: string;
}

interface ChannelEntry {
  channelId: Hex;
  salt: Hex;
  cumulativeAmount: bigint;
  nonce: number;
}

// In-memory channel state per payee:currency:escrow
const channelCache = new Map<string, ChannelEntry>();

function channelKey(payee: Address, currency: Address, escrow: Address): string {
  return `${payee.toLowerCase()}:${currency.toLowerCase()}:${escrow.toLowerCase()}`;
}

export interface CreateSessionCredentialOptions {
  challenge: SessionChallenge;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient?: PublicClient;
  config?: ArcSessionConfig;
  /** Callback when a new channel is opened */
  onChannelOpened?: (channelId: Hex, txHash: Hex) => void;
}

/**
 * Create a session credential for streaming payments on Arc.
 *
 * First call: opens a payment channel with an escrow deposit.
 * Subsequent calls: signs cumulative off-chain vouchers (sub-100ms, no on-chain tx).
 */
export async function createSessionCredential(
  options: CreateSessionCredentialOptions
): Promise<SessionCredentialPayload> {
  const { challenge, walletClient, config, onChannelOpened } = options;

  const chain = arcTestnet;
  const account = walletClient.account;
  const currency = challenge.currency || ARC_USDC;
  const escrow = challenge.escrow;
  const amountPerRequest = BigInt(challenge.amountPerRequest);
  const minDeposit = BigInt(challenge.minDeposit);

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain,
      transport: http(config?.rpcUrl),
    });

  const key = channelKey(challenge.payee, currency, escrow);
  let entry = channelCache.get(key);

  // If no channel exists, open one
  if (!entry) {
    entry = await openChannel({
      publicClient,
      walletClient,
      escrow,
      currency,
      payee: challenge.payee,
      deposit: minDeposit,
      onChannelOpened,
    });
    channelCache.set(key, entry);
  }

  // Sign a cumulative voucher
  entry.cumulativeAmount += amountPerRequest;
  entry.nonce += 1;

  const signature = await walletClient.signTypedData({
    domain: {
      ...STREAM_CHANNEL_EIP712_DOMAIN,
      chainId: chain.id,
      verifyingContract: escrow,
    },
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: {
      channelId: entry.channelId,
      cumulativeAmount: entry.cumulativeAmount,
      nonce: BigInt(entry.nonce),
    },
  });

  return {
    action: "voucher",
    channelId: entry.channelId,
    cumulativeAmount: entry.cumulativeAmount.toString(),
    nonce: entry.nonce.toString(),
    signature,
  };
}

async function openChannel(options: {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  escrow: Address;
  currency: Address;
  payee: Address;
  deposit: bigint;
  onChannelOpened?: (channelId: Hex, txHash: Hex) => void;
}): Promise<ChannelEntry> {
  const { publicClient, walletClient, escrow, currency, payee, deposit, onChannelOpened } = options;
  const account = walletClient.account;

  // Generate unique salt
  const salt = keccak256(
    encodePacked(
      ["address", "address", "uint256"],
      [account.address, payee, BigInt(Date.now())]
    )
  );

  // Check and approve USDC allowance
  const allowance = await publicClient.readContract({
    address: currency,
    abi: Erc20Abi,
    functionName: "allowance",
    args: [account.address, escrow],
  });

  if (allowance < deposit) {
    const approveTx = await walletClient.writeContract({
      address: currency,
      abi: Erc20Abi,
      functionName: "approve",
      args: [escrow, deposit * 10n], // Approve 10x for future topups
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
  }

  // Open channel
  const txHash = await walletClient.writeContract({
    address: escrow,
    abi: ArcStreamChannelAbi,
    functionName: "open",
    args: [payee, deposit, salt],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Compute channel ID
  const channelId = await publicClient.readContract({
    address: escrow,
    abi: ArcStreamChannelAbi,
    functionName: "computeChannelId",
    args: [account.address, payee, salt],
  }) as Hex;

  onChannelOpened?.(channelId, txHash);

  return {
    channelId,
    salt,
    cumulativeAmount: 0n,
    nonce: 0,
  };
}

/**
 * Get current channel state from the cache.
 */
export function getChannelState(payee: Address, currency: Address, escrow: Address): ChannelEntry | undefined {
  return channelCache.get(channelKey(payee, currency, escrow));
}

/**
 * Clear cached channel state (e.g., after close).
 */
export function clearChannelState(payee: Address, currency: Address, escrow: Address): void {
  channelCache.delete(channelKey(payee, currency, escrow));
}
