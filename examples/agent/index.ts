import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  createChargeCredential,
  createSessionCredential,
  type ChargeChallenge,
  type SessionChallenge,
} from "@mppx-arc/mpp";

// ─── Config ──────────────────────────────────────────────────────────

const AGENT_KEY = process.env.PRIVATE_KEY as Hex;
if (!AGENT_KEY) throw new Error("PRIVATE_KEY required");

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const RPC_URL = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";

const agentAccount = privateKeyToAccount(AGENT_KEY);

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

const walletClient = createWalletClient({
  account: agentAccount,
  chain: arcTestnet,
  transport: http(RPC_URL),
});

// ─── MPP-aware Fetch ─────────────────────────────────────────────────

async function mppFetch(url: string): Promise<any> {
  console.log(`\n→ GET ${url}`);

  // First request — expect 402
  const res = await fetch(url);

  if (res.status !== 402) {
    return res.json();
  }

  console.log("← 402 Payment Required");
  const challenge = await res.json();
  console.log("  Challenge:", JSON.stringify(challenge, null, 2));

  let credential: any;

  if (challenge.intent === "charge") {
    console.log("  Creating charge credential (pull mode)...");
    credential = await createChargeCredential({
      challenge: challenge as ChargeChallenge,
      walletClient,
      publicClient,
      mode: "pull",
    });
  } else if (challenge.intent === "session") {
    console.log("  Creating session credential...");
    credential = await createSessionCredential({
      challenge: challenge as SessionChallenge,
      walletClient,
      publicClient,
      onChannelOpened: (channelId, txHash) => {
        console.log(`  Channel opened: ${channelId}`);
        console.log(`  Tx: ${txHash}`);
      },
    });
  } else {
    throw new Error(`Unknown intent: ${challenge.intent}`);
  }

  // Retry with payment credential
  const credentialB64 = Buffer.from(JSON.stringify(credential)).toString("base64url");
  console.log("  Retrying with payment credential...");

  const paidRes = await fetch(url, {
    headers: {
      Authorization: `Payment ${credentialB64}`,
    },
  });

  if (!paidRes.ok) {
    const err = await paidRes.json();
    throw new Error(`Payment failed: ${err.error}`);
  }

  const receipt = paidRes.headers.get("Payment-Receipt");
  if (receipt) {
    const decoded = JSON.parse(Buffer.from(receipt, "base64url").toString());
    console.log("← 200 OK (Payment-Receipt:", decoded.reference, ")");
  }

  return paidRes.json();
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("MPP Arc Agent");
  console.log(`Agent address: ${agentAccount.address}`);
  console.log(`Server: ${SERVER_URL}`);
  console.log("─".repeat(60));

  // 1. One-time charge payment
  console.log("\n=== CHARGE PAYMENT (one-time, $0.10) ===");
  try {
    const premium = await mppFetch(`${SERVER_URL}/api/premium`);
    console.log("  Result:", premium.data);
  } catch (err: any) {
    console.error("  Error:", err.message);
  }

  // 2. Session payments (streaming, $0.01 per request)
  console.log("\n=== SESSION PAYMENTS (streaming, $0.01/req) ===");
  for (let i = 1; i <= 5; i++) {
    try {
      const data = await mppFetch(`${SERVER_URL}/api/data/${i}`);
      console.log(`  Data #${i}:`, data.data);
    } catch (err: any) {
      console.error(`  Error on request #${i}:`, err.message);
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log("Done. Agent made 6 paid requests (1 charge + 5 session).");
}

main().catch(console.error);
