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
  decodeAbiParameters,
  hexToBigInt,
} from "viem";
import {
  ARC_USDC,
  arcTestnet,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../constants.js";
import { Erc20Abi } from "../abi.js";
import type { ChargeCredentialPayload, ChargeReceipt, ArcChargeConfig } from "../types.js";

// Simple in-memory store for replay protection
const usedTxHashes = new Set<string>();
const usedNonces = new Set<string>();

export interface VerifyChargeOptions {
  credential: ChargeCredentialPayload;
  expectedRecipient: Address;
  expectedAmount: bigint;
  publicClient?: PublicClient;
  /** Wallet client for broadcasting pull-mode transfers (server pays gas) */
  walletClient?: WalletClient<Transport, Chain, Account>;
  config?: ArcChargeConfig;
}

/**
 * Verify a charge payment credential on Arc.
 *
 * Push mode: verifies the tx hash on-chain (transfer happened, correct recipient/amount).
 * Pull mode: verifies ERC-3009 signature, broadcasts transferWithAuthorization (server pays gas).
 */
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

  // Replay protection
  if (usedTxHashes.has(txHash)) {
    throw new Error(`Transaction ${txHash} already used for payment`);
  }

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${txHash} failed`);
  }

  // Verify it's a transfer to the expected recipient with expected amount
  // Look for Transfer(address,address,uint256) event
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const transferLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === currency.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[2] &&
      log.topics[2].toLowerCase().includes(expectedRecipient.slice(2).toLowerCase())
  );

  if (!transferLog) {
    throw new Error("No USDC transfer to expected recipient found in transaction");
  }

  const transferAmount = hexToBigInt(transferLog.data as Hex);
  if (transferAmount < expectedAmount) {
    throw new Error(
      `Transfer amount ${transferAmount} is less than expected ${expectedAmount}`
    );
  }

  usedTxHashes.add(txHash);

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

  // Replay protection on nonce
  const nonceKey = `${from}:${nonce}`;
  if (usedNonces.has(nonceKey)) {
    throw new Error("Authorization nonce already used");
  }

  // Check if nonce is already used on-chain
  const isUsed = await publicClient.readContract({
    address: currency,
    abi: Erc20Abi,
    functionName: "authorizationState",
    args: [from, nonce as Hex],
  });
  if (isUsed) {
    throw new Error("Authorization nonce already used on-chain");
  }

  // Verify ERC-3009 signature
  const valid = await verifyTypedData({
    address: from,
    domain: {
      ...USDC_EIP712_DOMAIN,
      chainId,
      verifyingContract: currency,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from,
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

  // Decode signature components for transferWithAuthorization
  const sigBytes = signature as Hex;
  const r = `0x${sigBytes.slice(2, 66)}` as Hex;
  const s = `0x${sigBytes.slice(66, 130)}` as Hex;
  const v = parseInt(sigBytes.slice(130, 132), 16);

  // Broadcast transferWithAuthorization (server pays gas)
  const txHash = await walletClient.writeContract({
    address: currency,
    abi: Erc20Abi,
    functionName: "transferWithAuthorization",
    args: [
      from,
      expectedRecipient,
      expectedAmount,
      BigInt(validAfter),
      BigInt(validBefore),
      nonce as Hex,
      v,
      r,
      s,
    ],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  usedNonces.add(nonceKey);

  return {
    method: "arc",
    status: "success",
    timestamp: Date.now(),
    reference: txHash,
    txHash,
    chainId,
  };
}

/**
 * Reset replay protection stores (for testing).
 */
export function resetChargeStore(): void {
  usedTxHashes.clear();
  usedNonces.clear();
}
