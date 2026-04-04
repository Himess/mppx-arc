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
  parseUnits,
  encodePacked,
  keccak256,
} from "viem";
import {
  ARC_USDC,
  arcTestnet,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from "../constants.js";
import { Erc20Abi } from "../abi.js";
import type { ChargeCredentialPayload, ArcChargeConfig } from "../types.js";

export interface ChargeChallenge {
  recipient: Address;
  amount: string;
  chainId: number;
  currency: Address;
}

export interface CreateChargeCredentialOptions {
  challenge: ChargeChallenge;
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient?: PublicClient;
  mode?: "push" | "pull";
  config?: ArcChargeConfig;
}

/**
 * Create a charge credential for a one-time USDC payment on Arc.
 *
 * Push mode: client broadcasts an ERC-20 transfer and sends the tx hash.
 * Pull mode: client signs an ERC-3009 transferWithAuthorization (gasless for client).
 */
export async function createChargeCredential(
  options: CreateChargeCredentialOptions
): Promise<ChargeCredentialPayload> {
  const {
    challenge,
    walletClient,
    mode = "pull",
    config,
  } = options;

  const chain = arcTestnet;
  const currency = challenge.currency || ARC_USDC;
  const amount = BigInt(challenge.amount);
  const account = walletClient.account;

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain,
      transport: http(config?.rpcUrl),
    });

  if (mode === "push") {
    return createPushCredential({
      publicClient,
      walletClient,
      currency,
      recipient: challenge.recipient,
      amount,
    });
  }

  return createPullCredential({
    walletClient,
    currency,
    recipient: challenge.recipient,
    amount,
    chainId: chain.id,
  });
}

async function createPushCredential(options: {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  currency: Address;
  recipient: Address;
  amount: bigint;
}): Promise<ChargeCredentialPayload> {
  const { publicClient, walletClient, currency, recipient, amount } = options;

  const txHash = await walletClient.writeContract({
    address: currency,
    abi: Erc20Abi,
    functionName: "approve",
    args: [recipient, amount],
  });

  // For push mode, we directly transfer
  // Using a simple ERC-20 transfer
  const transferTxHash = await walletClient.sendTransaction({
    to: currency,
    data: encodePacked(
      ["bytes4", "address", "uint256"],
      [
        "0xa9059cbb", // transfer(address,uint256)
        recipient,
        amount,
      ]
    ),
  });

  await publicClient.waitForTransactionReceipt({ hash: transferTxHash });

  return {
    mode: "push",
    txHash: transferTxHash,
  };
}

async function createPullCredential(options: {
  walletClient: WalletClient<Transport, Chain, Account>;
  currency: Address;
  recipient: Address;
  amount: bigint;
  chainId: number;
}): Promise<ChargeCredentialPayload> {
  const { walletClient, currency, recipient, amount, chainId } = options;
  const account = walletClient.account;

  // Generate random nonce for ERC-3009
  const nonceBytes = keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [account.address, amount, BigInt(Date.now())]
    )
  );

  const now = Math.floor(Date.now() / 1000);
  const validAfter = 0n;
  const validBefore = BigInt(now + 3600); // 1 hour validity

  const signature = await walletClient.signTypedData({
    domain: {
      ...USDC_EIP712_DOMAIN,
      chainId,
      verifyingContract: currency,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: recipient,
      value: amount,
      validAfter,
      validBefore,
      nonce: nonceBytes,
    },
  });

  return {
    mode: "pull",
    signature,
    from: account.address,
    nonce: nonceBytes,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
  };
}
