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
  hexToBigInt,
  getAddress,
  parseSignature,
} from "viem";
import {
  ARC_USDC,
  arcTestnet,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../constants.js";
import { Erc20Abi } from "../abi.js";
import type { ChargeCredentialPayload, ChargeReceipt, ArcChargeConfig } from "../types.js";

// C5/C6 FIX: Use a bounded LRU-style store with TTL
const MAX_STORE_SIZE = 100_000;
const STORE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface StoreEntry {
  timestamp: number;
}

const usedTxHashes = new Map<string, StoreEntry>();
const usedNonces = new Map<string, StoreEntry>();

function storeAdd(store: Map<string, StoreEntry>, key: string): void {
  // Evict expired entries when store is getting large
  if (store.size >= MAX_STORE_SIZE) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now - v.timestamp > STORE_TTL_MS) store.delete(k);
    }
    // If still too large, evict oldest 10%
    if (store.size >= MAX_STORE_SIZE) {
      const toDelete = Math.floor(store.size * 0.1);
      let count = 0;
      for (const k of store.keys()) {
        if (count++ >= toDelete) break;
        store.delete(k);
      }
    }
  }
  store.set(key, { timestamp: Date.now() });
}

function storeHas(store: Map<string, StoreEntry>, key: string): boolean {
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > STORE_TTL_MS) {
    store.delete(key);
    return false;
  }
  return true;
}

export interface VerifyChargeOptions {
  credential: ChargeCredentialPayload;
  expectedRecipient: Address;
  expectedAmount: bigint;
  publicClient?: PublicClient;
  walletClient?: WalletClient<Transport, Chain, Account>;
  config?: ArcChargeConfig;
}

export async function verifyCharge(options: VerifyChargeOptions): Promise<ChargeReceipt> {
  const { credential, expectedRecipient, expectedAmount, config } = options;

  const chain = arcTestnet;
  const currency = ARC_USDC;

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain,
      transport: http(config?.rpcUrl),
    });

  if (credential.mode === "push") {
    return verifyPushCharge({
      publicClient,
      txHash: credential.txHash!,
      expectedRecipient,
      expectedAmount,
      currency,
      chainId: chain.id,
    });
  }

  if (!options.walletClient) {
    throw new Error("Pull mode requires a walletClient to broadcast the transfer");
  }

  return verifyPullCharge({
    publicClient,
    walletClient: options.walletClient,
    credential,
    expectedRecipient,
    expectedAmount,
    currency,
    chainId: chain.id,
  });
}

async function verifyPushCharge(options: {
  publicClient: PublicClient;
  txHash: Hash;
  expectedRecipient: Address;
  expectedAmount: bigint;
  currency: Address;
  chainId: number;
}): Promise<ChargeReceipt> {
  const { publicClient, txHash, expectedRecipient, expectedAmount, currency, chainId } = options;

  if (storeHas(usedTxHashes, txHash)) {
    throw new Error(`Transaction ${txHash} already used for payment`);
  }

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${txHash} failed`);
  }

  // H7 FIX: Properly decode topic address instead of includes()
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const transferLog = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== currency.toLowerCase()) return false;
    if (log.topics[0] !== transferTopic) return false;
    if (!log.topics[2]) return false;
    const toAddress = getAddress("0x" + log.topics[2].slice(26));
    return toAddress.toLowerCase() === expectedRecipient.toLowerCase();
  });

  if (!transferLog) {
    throw new Error("No USDC transfer to expected recipient found in transaction");
  }

  const transferAmount = hexToBigInt(transferLog.data as Hex);
  if (transferAmount < expectedAmount) {
    throw new Error(`Transfer amount ${transferAmount} is less than expected ${expectedAmount}`);
  }

  storeAdd(usedTxHashes, txHash);

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: txHash,
    txHash,
    chainId,
  };
}

async function verifyPullCharge(options: {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  credential: ChargeCredentialPayload;
  expectedRecipient: Address;
  expectedAmount: bigint;
  currency: Address;
  chainId: number;
}): Promise<ChargeReceipt> {
  const {
    publicClient,
    walletClient,
    credential,
    expectedRecipient,
    expectedAmount,
    currency,
    chainId,
  } = options;

  const { signature, from, nonce, validAfter, validBefore } = credential;
  if (!signature || !from || !nonce || !validAfter || !validBefore) {
    throw new Error("Missing required fields for pull mode credential");
  }

  // M11 FIX: Check expiry before doing anything
  const now = Math.floor(Date.now() / 1000);
  if (BigInt(validBefore) <= BigInt(now)) {
    throw new Error("Authorization has expired (validBefore is in the past)");
  }

  const nonceKey = `${from}:${nonce}`;
  if (storeHas(usedNonces, nonceKey)) {
    throw new Error("Authorization nonce already used");
  }

  const isUsed = await publicClient.readContract({
    address: currency,
    abi: Erc20Abi,
    functionName: "authorizationState",
    args: [from as Address, nonce as Hex],
  });
  if (isUsed) {
    throw new Error("Authorization nonce already used on-chain");
  }

  const valid = await verifyTypedData({
    address: from as Address,
    domain: {
      ...USDC_EIP712_DOMAIN,
      chainId,
      verifyingContract: currency,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: from as Address,
      to: expectedRecipient,
      value: expectedAmount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: nonce as Hex,
    },
    signature: signature as Hex,
  });

  if (!valid) {
    throw new Error("Invalid ERC-3009 authorization signature");
  }

  // C3 FIX: Use parseSignature instead of manual slicing
  const parsed = parseSignature(signature as Hex);

  const txHash = await walletClient.writeContract({
    address: currency,
    abi: Erc20Abi,
    functionName: "transferWithAuthorization",
    args: [
      from as Address,
      expectedRecipient,
      expectedAmount,
      BigInt(validAfter),
      BigInt(validBefore),
      nonce as Hex,
      Number(parsed.v),
      parsed.r,
      parsed.s,
    ],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  storeAdd(usedNonces, nonceKey);

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: txHash,
    txHash,
    chainId,
  };
}

export function resetChargeStore(): void {
  usedTxHashes.clear();
  usedNonces.clear();
}
