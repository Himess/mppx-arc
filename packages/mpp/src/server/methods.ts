import { Method, Receipt, Store } from "mppx";
import {
  type Address,
  type Hex,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
  createPublicClient,
  http,
  verifyTypedData,
  hexToBigInt,
} from "viem";
import { charge, session } from "../methods.js";
import {
  ARC_USDC,
  arcTestnet,
  ARC_STREAM_CHANNEL,
  USDC_EIP712_DOMAIN,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
} from "../constants.js";
import { ArcStreamChannelAbi, Erc20Abi } from "../abi.js";

// ─── Server Channel State ────────────────────────────────────────────

interface ServerChannelState {
  payer: Address;
  payee: Address;
  deposit: bigint;
  settled: bigint;
  lastNonce: number;
  lastCumulativeAmount: bigint;
  pendingAmount: bigint;
}

const channelStore = new Map<string, ServerChannelState>();

// ─── Arc Charge Server ───────────────────────────────────────────────

export function arcCharge(options: {
  recipient: Address;
  walletClient?: WalletClient<Transport, Chain, Account>;
  publicClient?: PublicClient;
  rpcUrl?: string;
  store?: ReturnType<typeof Store.memory>;
}) {
  const store = options.store ?? Store.memory();
  const chain = arcTestnet;

  const publicClient =
    options.publicClient ??
    createPublicClient({ chain, transport: http(options.rpcUrl) });

  return Method.toServer(charge, {
    defaults: {
      currency: ARC_USDC,
      recipient: options.recipient,
      chainId: chain.id,
    },
    async verify({ credential, request }) {
      const payload = credential.payload;
      const expectedRecipient = request.recipient as Address;
      const expectedAmount = BigInt(request.amount);
      const chainId = Number(request.chainId);
      const currency = (request.currency || ARC_USDC) as Address;

      if (payload.mode === "push") {
        const txHash = payload.txHash as Hash;

        // Replay protection via Store
        const used = await store.get(`tx:${txHash}`);
        if (used) throw new Error(`Transaction ${txHash} already used`);

        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") throw new Error("Transaction failed");

        const transferTopic =
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        const transferLog = receipt.logs.find(
          (log) =>
            log.address.toLowerCase() === currency.toLowerCase() &&
            log.topics[0] === transferTopic &&
            log.topics[2]?.toLowerCase().includes(expectedRecipient.slice(2).toLowerCase())
        );

        if (!transferLog) throw new Error("No USDC transfer to recipient found");

        const transferAmount = hexToBigInt(transferLog.data as Hex);
        if (transferAmount < expectedAmount)
          throw new Error(`Transfer ${transferAmount} < expected ${expectedAmount}`);

        await store.put(`tx:${txHash}`, true);

        return Receipt.from({
          method: "arc",
          status: "success",
          timestamp: new Date().toISOString(),
          reference: txHash,
        });
      }

      // Pull mode: ERC-3009
      const { signature, from, nonce, validAfter, validBefore } = payload;
      if (!signature || !from || !nonce || !validAfter || !validBefore)
        throw new Error("Missing pull mode fields");

      const nonceKey = `nonce:${from}:${nonce}`;
      const usedNonce = await store.get(nonceKey);
      if (usedNonce) throw new Error("Nonce already used");

      const isUsedOnChain = await publicClient.readContract({
        address: currency,
        abi: Erc20Abi,
        functionName: "authorizationState",
        args: [from as Address, nonce as Hex],
      });
      if (isUsedOnChain) throw new Error("Nonce already used on-chain");

      const valid = await verifyTypedData({
        address: from as Address,
        domain: { ...USDC_EIP712_DOMAIN, chainId, verifyingContract: currency },
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
      if (!valid) throw new Error("Invalid ERC-3009 signature");

      // Broadcast transfer (server pays gas)
      if (!options.walletClient)
        throw new Error("Pull mode requires walletClient");

      const sigHex = signature as Hex;
      const r = `0x${sigHex.slice(2, 66)}` as Hex;
      const s = `0x${sigHex.slice(66, 130)}` as Hex;
      const v = parseInt(sigHex.slice(130, 132), 16);

      const txHash = await options.walletClient.writeContract({
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
          v,
          r,
          s,
        ],
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await store.put(nonceKey, true);

      return Receipt.from({
        method: "arc",
        status: "success",
        timestamp: new Date().toISOString(),
        reference: txHash,
      });
    },
  });
}

// ─── Arc Session Server ──────────────────────────────────────────────

export function arcSession(options: {
  payee: Address;
  escrow: Address;
  amountPerRequest: bigint;
  minDeposit?: bigint;
  walletClient?: WalletClient<Transport, Chain, Account>;
  publicClient?: PublicClient;
  rpcUrl?: string;
  autoSettleThreshold?: bigint;
}) {
  const chain = arcTestnet;
  const publicClient =
    options.publicClient ??
    createPublicClient({ chain, transport: http(options.rpcUrl) });

  return Method.toServer(session, {
    defaults: {
      payee: options.payee,
      escrow: options.escrow,
      chainId: chain.id,
      currency: ARC_USDC,
      amountPerRequest: options.amountPerRequest.toString(),
      minDeposit: (options.minDeposit ?? options.amountPerRequest * 100n).toString(),
    },
    async verify({ credential, request }) {
      const payload = credential.payload;
      const escrow = request.escrow as Address;
      const expectedPayee = request.payee as Address;
      const amountPerRequest = BigInt(request.amountPerRequest);
      const chainId = Number(request.chainId);

      switch (payload.action) {
        case "open": {
          if (!payload.txHash) throw new Error("Open requires txHash");

          const receipt = await publicClient.getTransactionReceipt({
            hash: payload.txHash as Hash,
          });
          if (receipt.status !== "success") throw new Error("Open tx failed");

          const channelId = payload.channelId as Hex;
          const channel = (await publicClient.readContract({
            address: escrow,
            abi: ArcStreamChannelAbi,
            functionName: "getChannel",
            args: [channelId],
          })) as any;

          if (channel.openedAt === 0n) throw new Error("Channel does not exist");
          if (channel.payee.toLowerCase() !== expectedPayee.toLowerCase())
            throw new Error("Payee mismatch");

          channelStore.set(channelId, {
            payer: channel.payer,
            payee: channel.payee,
            deposit: channel.deposit,
            settled: channel.settled,
            lastNonce: 0,
            lastCumulativeAmount: 0n,
            pendingAmount: 0n,
          });

          return Receipt.from({
            method: "arc",
            status: "success",
            timestamp: new Date().toISOString(),
            reference: payload.txHash,
          });
        }

        case "voucher": {
          const channelId = payload.channelId as Hex;
          const cumulativeAmount = BigInt(payload.cumulativeAmount!);
          const nonce = parseInt(payload.nonce!);
          const signature = payload.signature as Hex;

          const state = channelStore.get(channelId);
          if (!state) throw new Error("Channel not found");
          if (nonce <= state.lastNonce) throw new Error("Nonce not increasing");
          if (cumulativeAmount < state.lastCumulativeAmount)
            throw new Error("Cumulative amount decreased");

          const delta = cumulativeAmount - state.lastCumulativeAmount;
          if (delta < amountPerRequest)
            throw new Error(`Delta ${delta} < required ${amountPerRequest}`);
          if (cumulativeAmount > state.deposit)
            throw new Error("Exceeds deposit");

          const valid = await verifyTypedData({
            address: state.payer,
            domain: { ...STREAM_CHANNEL_EIP712_DOMAIN, chainId, verifyingContract: escrow },
            types: VOUCHER_TYPES,
            primaryType: "Voucher",
            message: { channelId, cumulativeAmount, nonce: BigInt(nonce) },
            signature,
          });
          if (!valid) throw new Error("Invalid voucher signature");

          state.lastNonce = nonce;
          state.lastCumulativeAmount = cumulativeAmount;
          state.pendingAmount += delta;

          // Auto-settle
          if (
            options.autoSettleThreshold &&
            state.pendingAmount >= options.autoSettleThreshold &&
            options.walletClient
          ) {
            const settleTx = await options.walletClient.writeContract({
              address: escrow,
              abi: ArcStreamChannelAbi,
              functionName: "settle",
              args: [channelId, cumulativeAmount, BigInt(nonce), signature],
            });
            await publicClient.waitForTransactionReceipt({ hash: settleTx });
            state.settled = cumulativeAmount;
            state.pendingAmount = 0n;
          }

          return Receipt.from({
            method: "arc",
            status: "success",
            timestamp: new Date().toISOString(),
            reference: `voucher:${channelId}:${nonce}`,
          });
        }

        case "topUp": {
          if (!payload.topUpTxHash) throw new Error("TopUp requires topUpTxHash");
          const receipt = await publicClient.getTransactionReceipt({
            hash: payload.topUpTxHash as Hash,
          });
          if (receipt.status !== "success") throw new Error("TopUp tx failed");

          const channelId = payload.channelId as Hex;
          const channel = (await publicClient.readContract({
            address: escrow,
            abi: ArcStreamChannelAbi,
            functionName: "getChannel",
            args: [channelId],
          })) as any;

          const state = channelStore.get(channelId);
          if (state) state.deposit = channel.deposit;

          return Receipt.from({
            method: "arc",
            status: "success",
            timestamp: new Date().toISOString(),
            reference: payload.topUpTxHash,
          });
        }

        case "close": {
          if (!options.walletClient) throw new Error("Close requires walletClient");
          const channelId = payload.channelId as Hex;
          const cumulativeAmount = BigInt(payload.cumulativeAmount!);
          const nonce = parseInt(payload.nonce!);

          const txHash = await options.walletClient.writeContract({
            address: escrow,
            abi: ArcStreamChannelAbi,
            functionName: "close",
            args: [channelId, cumulativeAmount, BigInt(nonce), payload.signature as Hex],
          });
          await publicClient.waitForTransactionReceipt({ hash: txHash });
          channelStore.delete(channelId);

          return Receipt.from({
            method: "arc",
            status: "success",
            timestamp: new Date().toISOString(),
            reference: txHash,
          });
        }

        default:
          throw new Error(`Unknown action: ${payload.action}`);
      }
    },

    // Session management responses (open/close/topUp return 204)
    respond({ credential, receipt }) {
      const action = credential.payload.action;
      if (action === "open" || action === "close" || action === "topUp") {
        return new Response(null, {
          status: 204,
          headers: { "Payment-Receipt": Receipt.serialize(receipt) },
        });
      }
      return undefined;
    },
  });
}
