import { Method, Credential, z } from "mppx";
import {
  type Account,
  type Chain,
  type Transport,
  type WalletClient,
  type PublicClient,
  type Address,
  type Hex,
  createPublicClient,
  http,
  keccak256,
  encodePacked,
} from "viem";
import { charge, session } from "../methods.js";
import {
  ARC_USDC,
  arcTestnet,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
} from "../constants.js";
import { ArcStreamChannelAbi, Erc20Abi } from "../abi.js";

// ─── Client Context Schema ──────────────────────────────────────────

const chargeContext = z.object({
  walletClient: z.any(),
  publicClient: z.optional(z.any()),
  mode: z.optional(z.enum(["push", "pull"])),
});

const sessionContext = z.object({
  walletClient: z.any(),
  publicClient: z.optional(z.any()),
  onChannelOpened: z.optional(z.any()),
});

// ─── Channel Cache (session) ─────────────────────────────────────────

interface ChannelEntry {
  channelId: Hex;
  salt: Hex;
  cumulativeAmount: bigint;
  nonce: number;
}

const channelCache = new Map<string, ChannelEntry>();

// ─── Arc Charge Client ───────────────────────────────────────────────

export function arcCharge() {
  return Method.toClient(charge, {
    context: chargeContext,
    async createCredential({ challenge, context }) {
      const walletClient = context.walletClient as WalletClient<Transport, Chain, Account>;
      const mode = context.mode ?? "pull";
      const account = walletClient.account;
      const currency = (challenge.request.currency || ARC_USDC) as Address;
      const amount = BigInt(challenge.request.amount);
      const recipient = challenge.request.recipient as Address;
      const chainId = challenge.request.chainId;

      if (mode === "push") {
        const pc = (context.publicClient ??
          createPublicClient({ chain: arcTestnet, transport: http() })) as PublicClient;

        // C1/C2 FIX: Use writeContract with proper ABI encoding
        const transferTxHash = await walletClient.writeContract({
          address: currency,
          abi: [{
            type: "function",
            name: "transfer",
            inputs: [
              { name: "to", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ type: "bool" }],
            stateMutability: "nonpayable",
          }] as const,
          functionName: "transfer",
          args: [recipient, amount],
        });
        await pc.waitForTransactionReceipt({ hash: transferTxHash });

        return Credential.serialize(
          Credential.from({
            challenge,
            payload: { mode: "push", txHash: transferTxHash },
          })
        );
      }

      // Pull mode: sign ERC-3009
      const nonceBytes = keccak256(
        encodePacked(
          ["address", "uint256", "uint256"],
          [account.address, amount, BigInt(Date.now())]
        )
      );
      const validAfter = 0n;
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const signature = await walletClient.signTypedData({
        domain: { ...USDC_EIP712_DOMAIN, chainId, verifyingContract: currency },
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

      return Credential.serialize(
        Credential.from({
          challenge,
          payload: {
            mode: "pull",
            signature,
            from: account.address,
            nonce: nonceBytes,
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
          },
        })
      );
    },
  });
}

// ─── Arc Session Client ──────────────────────────────────────────────

export function arcSession() {
  return Method.toClient(session, {
    context: sessionContext,
    async createCredential({ challenge, context }) {
      const walletClient = context.walletClient as WalletClient<Transport, Chain, Account>;
      const account = walletClient.account;
      const escrow = challenge.request.escrow as Address;
      const payee = challenge.request.payee as Address;
      const currency = (challenge.request.currency || ARC_USDC) as Address;
      const amountPerRequest = BigInt(challenge.request.amountPerRequest);
      const minDeposit = BigInt(challenge.request.minDeposit);
      const chainId = challenge.request.chainId;

      const pc = (context.publicClient ??
        createPublicClient({ chain: arcTestnet, transport: http() })) as PublicClient;

      const key = `${payee}:${currency}:${escrow}`.toLowerCase();
      let entry = channelCache.get(key);

      if (!entry) {
        // Open channel
        const salt = keccak256(
          encodePacked(
            ["address", "address", "uint256"],
            [account.address, payee, BigInt(Date.now())]
          )
        );

        const allowance = await pc.readContract({
          address: currency,
          abi: Erc20Abi,
          functionName: "allowance",
          args: [account.address, escrow],
        }) as bigint;

        if (allowance < minDeposit) {
          const approveTx = await walletClient.writeContract({
            address: currency,
            abi: Erc20Abi,
            functionName: "approve",
            args: [escrow, minDeposit * 10n],
          });
          await pc.waitForTransactionReceipt({ hash: approveTx });
        }

        const txHash = await walletClient.writeContract({
          address: escrow,
          abi: ArcStreamChannelAbi,
          functionName: "open",
          args: [payee, minDeposit, salt],
        });
        await pc.waitForTransactionReceipt({ hash: txHash });

        const channelId = await pc.readContract({
          address: escrow,
          abi: ArcStreamChannelAbi,
          functionName: "computeChannelId",
          args: [account.address, payee, salt],
        }) as Hex;

        context.onChannelOpened?.(channelId, txHash);

        entry = { channelId, salt, cumulativeAmount: 0n, nonce: 0 };
        channelCache.set(key, entry);

        return Credential.serialize(
          Credential.from({
            challenge,
            payload: { action: "open", channelId, txHash },
          })
        );
      }

      // Sign voucher
      entry.cumulativeAmount += amountPerRequest;
      entry.nonce += 1;

      const signature = await walletClient.signTypedData({
        domain: { ...STREAM_CHANNEL_EIP712_DOMAIN, chainId, verifyingContract: escrow },
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message: {
          channelId: entry.channelId,
          cumulativeAmount: entry.cumulativeAmount,
          nonce: BigInt(entry.nonce),
        },
      });

      return Credential.serialize(
        Credential.from({
          challenge,
          payload: {
            action: "voucher",
            channelId: entry.channelId,
            cumulativeAmount: entry.cumulativeAmount.toString(),
            nonce: entry.nonce.toString(),
            signature,
          },
        })
      );
    },
  });
}
