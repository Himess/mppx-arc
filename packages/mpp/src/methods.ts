import { Method, z } from "mppx";

// M3 FIX: Stricter Zod schemas with hex/address validation
const hexString = z.string().check(
  z.regex(/^0x[a-fA-F0-9]*$/),
);
const addressString = z.string().check(
  z.regex(/^0x[a-fA-F0-9]{40}$/),
);

/**
 * Arc charge method — one-time USDC payment via ERC-3009 or direct transfer.
 */
export const charge = Method.from({
  name: "arc",
  intent: "charge",
  schema: {
    credential: {
      payload: z.object({
        mode: z.enum(["push", "pull"]),
        txHash: z.optional(z.string()),
        signature: z.optional(z.string()),
        from: z.optional(z.string()),
        nonce: z.optional(z.string()),
        validAfter: z.optional(z.string()),
        validBefore: z.optional(z.string()),
      }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      chainId: z.pipe(z.union([z.string(), z.number()]), z.transform(Number)),
    }),
  },
});

/**
 * Arc session method — streaming micropayments via payment channels.
 */
export const session = Method.from({
  name: "arc",
  intent: "session",
  schema: {
    credential: {
      payload: z.object({
        action: z.enum(["open", "voucher", "topUp", "close"]),
        channelId: z.string(),
        txHash: z.optional(z.string()),
        cumulativeAmount: z.optional(z.string()),
        nonce: z.optional(z.string()),
        signature: z.optional(z.string()),
        topUpTxHash: z.optional(z.string()),
      }),
    },
    request: z.object({
      payee: z.string(),
      escrow: z.string(),
      chainId: z.pipe(z.union([z.string(), z.number()]), z.transform(Number)),
      currency: z.string(),
      amountPerRequest: z.string(),
      minDeposit: z.string(),
    }),
  },
});

export const Methods = { charge, session } as const;
