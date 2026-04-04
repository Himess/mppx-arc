import type { Address } from "viem";

// H8 FIX: HTML escape function to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PaymentPageOptions {
  /** Server/merchant name */
  merchantName?: string;
  /** Payment amount in USDC (display format, e.g. "0.10") */
  displayAmount: string;
  /** Recipient address */
  recipient: Address;
  /** Payment intent: "charge" or "session" */
  intent: "charge" | "session";
  /** Chain name */
  chainName?: string;
  /** Explorer URL for the recipient */
  explorerUrl?: string;
}

/**
 * Generate an HTML payment page for browser users.
 *
 * When a browser (Accept: text/html) hits a 402 endpoint,
 * serve this page instead of raw JSON.
 */
export function renderPaymentPage(options: PaymentPageOptions): string {
  const {
    merchantName = "MPP Service",
    displayAmount,
    recipient,
    intent,
    chainName = "Arc Testnet",
    explorerUrl = `https://testnet.arcscan.app/address/${recipient}`,
  } = options;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Required — ${escapeHtml(merchantName)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
    }
    .status {
      font-size: 14px;
      color: #a855f7;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #fafafa;
    }
    .amount {
      font-size: 48px;
      font-weight: 800;
      color: #3b82f6;
      margin: 24px 0;
    }
    .amount span {
      font-size: 20px;
      color: #6b7280;
      font-weight: 400;
    }
    .details {
      background: #0a0a0a;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 16px;
      margin: 24px 0;
      text-align: left;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #1a1a1a;
    }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { color: #6b7280; font-size: 13px; }
    .detail-value {
      color: #d4d4d4;
      font-size: 13px;
      font-family: monospace;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail-value a {
      color: #3b82f6;
      text-decoration: none;
    }
    .detail-value a:hover { text-decoration: underline; }
    .info {
      font-size: 13px;
      color: #6b7280;
      margin-top: 24px;
      line-height: 1.5;
    }
    .badge {
      display: inline-block;
      background: #1e1b4b;
      color: #818cf8;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      margin-top: 16px;
    }
    .protocol {
      margin-top: 24px;
      font-size: 11px;
      color: #404040;
    }
    .protocol a { color: #525252; text-decoration: none; }
    .protocol a:hover { color: #737373; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">402 Payment Required</div>
    <h1>${escapeHtml(merchantName)}</h1>
    <div class="amount">$${escapeHtml(displayAmount)} <span>USDC</span></div>
    <div class="details">
      <div class="detail-row">
        <span class="detail-label">Network</span>
        <span class="detail-value">${escapeHtml(chainName)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Payment Type</span>
        <span class="detail-value">${intent === "charge" ? "One-time" : "Session (streaming)"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Recipient</span>
        <span class="detail-value">
          <a href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener">
            ${recipient.slice(0, 6)}...${recipient.slice(-4)}
          </a>
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Currency</span>
        <span class="detail-value">USDC (native)</span>
      </div>
    </div>
    <div class="info">
      This endpoint requires payment via the Machine Payments Protocol (MPP).
      Send an <code>Authorization: Payment</code> header with your credential to access this resource.
    </div>
    <div class="badge">MPP-compatible on Arc</div>
    <div class="protocol">
      Powered by <a href="https://mpp.dev">MPP</a> &middot;
      <a href="https://arc.circle.com">Arc Chain</a>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Create a 402 Response with HTML payment page for browser clients.
 */
export function createPaymentPageResponse(
  options: PaymentPageOptions & { wwwAuthenticate: string }
): Response {
  return new Response(renderPaymentPage(options), {
    status: 402,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "WWW-Authenticate": options.wwwAuthenticate,
    },
  });
}

/**
 * Check if the request is from a browser (Accept: text/html).
 */
export function isBrowserRequest(request: Request): boolean {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html");
}
