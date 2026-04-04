import {
  type Address,
  type Hex,
  verifyTypedData,
} from "viem";
import {
  STREAM_CHANNEL_EIP712_DOMAIN,
  VOUCHER_TYPES,
} from "../constants.js";

/**
 * SSE streaming response with per-token voucher verification.
 *
 * Each SSE event requires a new signed voucher from the payer,
 * enabling pay-per-token streaming (e.g., LLM responses).
 *
 * Usage:
 * ```ts
 * return createSSEStream({
 *   channelState, escrow, chainId,
 *   amountPerToken: 100n, // $0.0001 per token
 *   async *generate() {
 *     for await (const token of llmStream) {
 *       yield token;
 *     }
 *   },
 * });
 * ```
 */

interface ChannelStateForSSE {
  payer: Address;
  deposit: bigint;
  lastNonce: number;
  lastCumulativeAmount: bigint;
}

export interface SSEStreamOptions {
  /** Channel state from the server store */
  channelState: ChannelStateForSSE;
  /** Escrow contract address */
  escrow: Address;
  /** Chain ID */
  chainId: number;
  /** Amount charged per SSE event/token (atomic USDC) */
  amountPerToken: bigint;
  /** Async generator that yields content tokens/chunks */
  generate: () => AsyncGenerator<string, void, unknown>;
  /** Optional: called when a voucher is needed from the client */
  requestVoucher?: () => Promise<{
    cumulativeAmount: bigint;
    nonce: number;
    signature: Hex;
  }>;
}

/**
 * Create an SSE Response with payment-gated streaming.
 *
 * For server-initiated streaming where vouchers are pre-signed:
 * The client provides vouchers upfront covering N tokens, and the
 * server streams until the voucher budget is exhausted.
 */
export function createSSEStream(options: {
  channelState: ChannelStateForSSE;
  escrow: Address;
  chainId: number;
  amountPerToken: bigint;
  generate: () => AsyncGenerator<string, void, unknown>;
  /** Pre-signed voucher covering the maximum streaming budget */
  voucher: {
    channelId: Hex;
    cumulativeAmount: bigint;
    nonce: number;
    signature: Hex;
  };
}): Response {
  const {
    channelState,
    escrow,
    chainId,
    amountPerToken,
    generate,
    voucher,
  } = options;

  const maxTokens = Number(
    (voucher.cumulativeAmount - channelState.lastCumulativeAmount) / amountPerToken
  );

  const encoder = new TextEncoder();
  let tokenCount = 0;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Verify the voucher upfront
        const valid = await verifyTypedData({
          address: channelState.payer,
          domain: {
            ...STREAM_CHANNEL_EIP712_DOMAIN,
            chainId,
            verifyingContract: escrow,
          },
          types: VOUCHER_TYPES,
          primaryType: "Voucher",
          message: {
            channelId: voucher.channelId,
            cumulativeAmount: voucher.cumulativeAmount,
            nonce: BigInt(voucher.nonce),
          },
          signature: voucher.signature,
        });

        if (!valid) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: Invalid voucher signature\n\n`)
          );
          controller.close();
          return;
        }

        // L6 FIX: Check budget BEFORE incrementing to avoid off-by-one
        const gen = generate();
        for await (const token of gen) {
          if (tokenCount >= maxTokens) {
            controller.enqueue(
              encoder.encode(
                `event: payment_required\ndata: ${JSON.stringify({
                  tokensUsed: tokenCount,
                  amountCharged: (BigInt(tokenCount) * amountPerToken).toString(),
                  message: "Voucher budget exhausted. Send a new voucher to continue.",
                })}\n\n`
              )
            );
            break;
          }

          tokenCount++;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ token, index: tokenCount })}\n\n`)
          );
        }

        // Final event — charge only for tokens actually delivered
        const totalCharged = BigInt(tokenCount) * amountPerToken;
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({
              tokensUsed: tokenCount,
              totalCharged: totalCharged.toString(),
            })}\n\n`
          )
        );
        controller.close();

        // Update channel state
        channelState.lastCumulativeAmount += totalCharged;
        channelState.lastNonce = voucher.nonce;
      } catch (err: any) {
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${err.message}\n\n`)
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-MPP-Channel-Id": voucher.channelId,
      "X-MPP-Tokens-Budget": maxTokens.toString(),
    },
  });
}
