import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  ARC_USDC,
  verifyCharge,
  verifySession,
  type ChargeCredentialPayload,
  type SessionCredentialPayload,
} from "@mppx-arc/mpp";

// ─── Config ──────────────────────────────────────────────────────────

const SERVER_KEY = process.env.PRIVATE_KEY as Hex;
if (!SERVER_KEY) throw new Error("PRIVATE_KEY required");

const ESCROW = process.env.ESCROW_ADDRESS as Hex;
if (!ESCROW) throw new Error("ESCROW_ADDRESS required");

const PORT = parseInt(process.env.PORT || "3000");
const RPC_URL = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";

const serverAccount = privateKeyToAccount(SERVER_KEY);

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(RPC_URL),
});

const walletClient = createWalletClient({
  account: serverAccount,
  chain: arcTestnet,
  transport: http(RPC_URL),
});

// ─── Pricing ─────────────────────────────────────────────────────────

const CHARGE_PRICE = parseUnits("0.10", 6); // $0.10 per request
const SESSION_PRICE = parseUnits("0.01", 6); // $0.01 per request
const MIN_DEPOSIT = parseUnits("1", 6); // $1.00 minimum deposit

// ─── App ─────────────────────────────────────────────────────────────

const app = new Hono();

// Health check
app.get("/", (c) => c.json({ status: "ok", server: serverAccount.address }));

// ─── Charge Endpoint (one-time payment) ──────────────────────────────

app.get("/api/premium", async (c) => {
  const authHeader = c.req.header("Authorization");

  // No payment — return 402
  if (!authHeader?.startsWith("Payment ")) {
    return c.json(
      {
        method: "arc",
        intent: "charge",
        recipient: serverAccount.address,
        amount: CHARGE_PRICE.toString(),
        chainId: arcTestnet.id,
        currency: ARC_USDC,
      },
      402,
      {
        "WWW-Authenticate": `Payment method="arc", intent="charge", recipient="${serverAccount.address}", amount="${CHARGE_PRICE}", chainId="${arcTestnet.id}", currency="${ARC_USDC}"`,
      }
    );
  }

  // Verify payment
  try {
    const credential = JSON.parse(
      Buffer.from(authHeader.slice(8), "base64url").toString()
    ) as ChargeCredentialPayload;

    const receipt = await verifyCharge({
      credential,
      expectedRecipient: serverAccount.address,
      expectedAmount: CHARGE_PRICE,
      publicClient,
      walletClient,
    });

    return c.json(
      {
        data: "This is premium content on Arc, paid via MPP charge!",
        price: "$0.10 USDC",
        receipt,
      },
      200,
      {
        "Payment-Receipt": Buffer.from(JSON.stringify(receipt)).toString("base64url"),
      }
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 403);
  }
});

// ─── Session Endpoint (streaming micropayments) ──────────────────────

app.get("/api/data/:id", async (c) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Payment ")) {
    return c.json(
      {
        method: "arc",
        intent: "session",
        payee: serverAccount.address,
        escrow: ESCROW,
        chainId: arcTestnet.id,
        currency: ARC_USDC,
        amountPerRequest: SESSION_PRICE.toString(),
        minDeposit: MIN_DEPOSIT.toString(),
      },
      402,
      {
        "WWW-Authenticate": `Payment method="arc", intent="session", payee="${serverAccount.address}", escrow="${ESCROW}", amountPerRequest="${SESSION_PRICE}", minDeposit="${MIN_DEPOSIT}", chainId="${arcTestnet.id}", currency="${ARC_USDC}"`,
      }
    );
  }

  try {
    const credential = JSON.parse(
      Buffer.from(authHeader.slice(8), "base64url").toString()
    ) as SessionCredentialPayload;

    const receipt = await verifySession({
      credential,
      expectedPayee: serverAccount.address,
      amountPerRequest: SESSION_PRICE,
      escrow: ESCROW,
      publicClient,
      walletClient,
      autoSettleThreshold: parseUnits("0.50", 6), // Auto-settle at $0.50
    });

    const id = c.req.param("id");
    return c.json(
      {
        data: { id, value: Math.random() * 100, timestamp: Date.now() },
        price: "$0.01 USDC per request",
        receipt,
      },
      200,
      {
        "Payment-Receipt": Buffer.from(JSON.stringify(receipt)).toString("base64url"),
      }
    );
  } catch (err: any) {
    return c.json({ error: err.message }, 403);
  }
});

// ─── Start ───────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`MPP Arc Server running on http://localhost:${info.port}`);
  console.log(`Server address: ${serverAccount.address}`);
  console.log(`Escrow contract: ${ESCROW}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET /api/premium   — $0.10 one-time charge`);
  console.log(`  GET /api/data/:id  — $0.01 per request (session)`);
});
