import { type Address, type Chain } from "viem";

// ─── Arc Chain Definition ────────────────────────────────────────────

export const arcTestnet: Chain = {
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.testnet.arc.network"],
      webSocket: ["wss://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: "https://testnet.arcscan.app",
    },
  },
  testnet: true,
};

// ─── Contract Addresses ──────────────────────────────────────────────

export const ARC_USDC: Address =
  "0x3600000000000000000000000000000000000000";

export const ARC_STREAM_CHANNEL: Record<number, Address> = {
  [arcTestnet.id]: "0x805aCAD6064CBfABac71a021c3ab432920925533",
};

// ─── USDC ERC-3009 EIP-712 Domain ────────────────────────────────────

export const USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
} as const;

// ─── Stream Channel EIP-712 ──────────────────────────────────────────

export const STREAM_CHANNEL_EIP712_DOMAIN = {
  name: "Arc Stream Channel",
  version: "1",
} as const;

// ─── EIP-712 Type Definitions ────────────────────────────────────────

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint128" },
    { name: "nonce", type: "uint256" },
  ],
} as const;
