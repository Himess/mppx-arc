export const ArcStreamChannelAbi = [
  // ─── Write Functions ─────────────────────────────────────────────
  {
    type: "function",
    name: "open",
    inputs: [
      { name: "payee", type: "address" },
      { name: "deposit", type: "uint128" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "channelId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint128" },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "topUp",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "additionalDeposit", type: "uint128" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "close",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint128" },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "requestClose",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // ─── View Functions ──────────────────────────────────────────────
  {
    type: "function",
    name: "computeChannelId",
    inputs: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "getChannel",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "deposit", type: "uint128" },
          { name: "settled", type: "uint128" },
          { name: "openedAt", type: "uint64" },
          { name: "closeRequestedAt", type: "uint64" },
          { name: "closed", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getChannelsBatch",
    inputs: [{ name: "channelIds", type: "bytes32[]" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "deposit", type: "uint128" },
          { name: "settled", type: "uint128" },
          { name: "openedAt", type: "uint64" },
          { name: "closeRequestedAt", type: "uint64" },
          { name: "closed", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVoucherHash",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint128" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "domainSeparator",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "USDC",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "channelNonces",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CLOSE_GRACE_PERIOD",
    inputs: [],
    outputs: [{ type: "uint64" }],
    stateMutability: "view",
  },

  // ─── Events ──────────────────────────────────────────────────────
  {
    type: "event",
    name: "ChannelOpened",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "deposit", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelSettled",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelToppedUp",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "newDeposit", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelCloseRequested",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "closableAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelClosed",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payeeAmount", type: "uint128", indexed: false },
      { name: "payerRefund", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ChannelWithdrawn",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "payerRefund", type: "uint128", indexed: false },
    ],
  },

  // ─── Errors ──────────────────────────────────────────────────────
  { type: "error", name: "ChannelAlreadyExists", inputs: [] },
  { type: "error", name: "ChannelDoesNotExist", inputs: [] },
  { type: "error", name: "ChannelAlreadyClosed", inputs: [] },
  { type: "error", name: "ChannelNotCloseRequested", inputs: [] },
  { type: "error", name: "GracePeriodNotElapsed", inputs: [] },
  { type: "error", name: "InvalidDeposit", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  { type: "error", name: "AmountExceedsDeposit", inputs: [] },
  { type: "error", name: "CumulativeAmountDecreased", inputs: [] },
  { type: "error", name: "OnlyPayer", inputs: [] },
  { type: "error", name: "OnlyPayee", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
] as const;

export const Erc20Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "authorizationState",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "version",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
  },
] as const;
