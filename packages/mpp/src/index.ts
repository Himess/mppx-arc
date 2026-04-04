// ─── mppx Plugin Interface ───────────────────────────────────────────

export { Methods, charge, session } from "./methods.js";
export { arcCharge as arcChargeClient, arcSession as arcSessionClient } from "./client/methods.js";
export { arcCharge as arcChargeServer, arcSession as arcSessionServer } from "./server/methods.js";

// ─── Standalone API ──────────────────────────────────────────────────

export { createChargeCredential, type CreateChargeCredentialOptions, type ChargeChallenge } from "./client/charge.js";
export {
  createSessionCredential,
  getChannelState,
  clearChannelState,
  type CreateSessionCredentialOptions,
  type SessionChallenge,
} from "./client/session.js";
export {
  verifyCharge,
  resetChargeStore,
  type VerifyChargeOptions,
} from "./server/charge.js";
export {
  verifySession,
  getServerChannelState,
  resetSessionStore,
  type VerifySessionOptions,
} from "./server/session.js";

export * from "./constants.js";
export * from "./types.js";
export { ArcStreamChannelAbi, Erc20Abi } from "./abi.js";
