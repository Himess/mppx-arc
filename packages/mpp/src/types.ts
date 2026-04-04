import type { Address, Hex, Hash } from "viem";

// ─── Charge Types ────────────────────────────────────────────────────

export interface ChargeRequest {
  /** Recipient address (server/merchant) */
  recipient: Address;
  /** Amount in USDC atomic units (6 decimals). e.g. "1000000" = 1 USDC */
  amount: string;
  /** Arc chain ID */
  chainId: number;
  /** USDC token address on Arc */
  currency: Address;
}

export interface ChargeCredentialPayload {
  /** Mode: "push" (client broadcasts tx) or "pull" (client signs, server broadcasts) */
  mode: "push" | "pull";
  /** For push mode: transaction hash of the completed transfer */
  txHash?: Hash;
  /** For pull mode: ERC-3009 authorization signature */
  signature?: Hex;
  /** For pull mode: signer/payer address */
  from?: Address;
  /** For pull mode: random nonce for ERC-3009 */
  nonce?: Hex;
  /** For pull mode: validity window start (unix timestamp) */
  validAfter?: string;
  /** For pull mode: validity window end (unix timestamp) */
  validBefore?: string;
}

export interface ChargeReceipt {
  method: "arc";
  status: "success";
  timestamp: number;
  reference: string;
  txHash: Hash;
  chainId: number;
}

// ─── Session Types ───────────────────────────────────────────────────

export interface SessionRequest {
  /** Payee address (server/merchant) */
  payee: Address;
  /** Escrow contract address */
  escrow: Address;
  /** Arc chain ID */
  chainId: number;
  /** USDC token address */
  currency: Address;
  /** Amount per request in atomic units */
  amountPerRequest: string;
  /** Minimum escrow deposit in atomic units */
  minDeposit: string;
}

export interface SessionCredentialPayload {
  /** Session action */
  action: "open" | "voucher" | "topUp" | "close";
  /** Channel ID (from escrow contract) */
  channelId: Hex;
  /** For open: tx hash of the open() call */
  txHash?: Hash;
  /** For voucher/close: cumulative amount */
  cumulativeAmount?: string;
  /** For voucher/close: voucher nonce */
  nonce?: string;
  /** For voucher/close: EIP-712 voucher signature */
  signature?: Hex;
  /** For topUp: tx hash of the topUp() call */
  topUpTxHash?: Hash;
}

export interface SessionReceipt {
  method: "arc";
  status: "success";
  timestamp: number;
  reference: string;
  channelId: Hex;
  cumulativeAmount: string;
}

// ─── Channel State ───────────────────────────────────────────────────

export interface ChannelState {
  channelId: Hex;
  payer: Address;
  payee: Address;
  deposit: bigint;
  settled: bigint;
  currentNonce: number;
  cumulativeAmount: bigint;
}

// ─── Config ──────────────────────────────────────────────────────────

export interface ArcChargeConfig {
  /** Arc chain to use */
  chainId?: number;
  /** USDC address override */
  currency?: Address;
  /** RPC URL override */
  rpcUrl?: string;
  /** Auto-settle threshold for batch settlement (session) */
  autoSettleThreshold?: bigint;
}

export interface ArcSessionConfig extends ArcChargeConfig {
  /** Stream channel escrow contract address */
  escrow: Address;
  /** Amount charged per API request (atomic USDC) */
  amountPerRequest: bigint;
  /** Minimum deposit required to open a channel */
  minDeposit?: bigint;
}
