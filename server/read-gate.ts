/**
 * The meter on the document reader (`/api/v1/read` and the hosted MCP at `/mcp`).
 *
 * No account is needed: every caller gets READM3_FREE_READS reads per
 * READM3_FREE_READS_WINDOW seconds (default 20 an hour, by address). Past that
 * the answer is 402 with an x402 offer for a reader pass (READM3_READ_PRICE_CENTS,
 * default $1 for a day), payable in USDC through CoinPay, rather than a 429. A pass
 * or a Profullstack Power Key reads unmetered, and so does a signed-in readm3
 * account (session cookie or API token): accounts are throttled per minute by the
 * API instead. Payments switch on only with COINPAY_X402_KEY and CRAWL_PAY_TO;
 * without them the free allowance still applies and running out is still a 402.
 */
import { createGateway } from "@profullstack/x402-gateway";

export const READ_PATHS = ["/api/v1/read", "/mcp"];

export type ReadGate = { handle: (request: Request) => Promise<Response | null> };

const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function createReadGate(
  env: Record<string, string | undefined> = process.env,
  /** Whether a bearer token is a live readm3 credential: true, false (refused) or null (not ours). */
  verifyToken: (token: string) => boolean | null = () => null,
): ReadGate {
  const apiKey = env.COINPAY_X402_KEY ?? "";
  const payTo = env.CRAWL_PAY_TO ?? "";
  const requests = number(env.READM3_FREE_READS, 20);
  const windowSeconds = number(env.READM3_FREE_READS_WINDOW, 3600);
  const gateway = createGateway({
    siteUrl: (env.READM3_URL || "https://readm3.com").replace(/\/+$/, ""),
    siteName: "readm3 reader",
    ...(apiKey ? { coinpay: { apiKey } } : {}),
    ...(payTo ? { payTo } : {}),
    priceCents: number(env.READM3_READ_PRICE_CENTS, 100),
    path: "/read/pass",
    contact: "mailto:anthony@profullstack.com",
    // Only the reader is metered here; the crawl gate looks after the pages.
    isPaidAgent: () => false,
    suspectAllowance: false,
    freeQuota: { requests, windowSeconds, paths: READ_PATHS },
    benefits: [
      "Unlimited document reads for the day",
      "PDFs, web pages, Word, Excel, PowerPoint, OpenDocument and EPUB",
      "The same pass works on the API and the MCP",
    ],
    // A signed-in browser, verified: a made-up cookie must not open the meter.
    exempt: (request: Request) => {
      const session = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)(?:__Host-)?readm3_session=([^;]+)/)?.[1];
      return Boolean(session && verifyToken(session) === true);
    },
    authenticate: (request: Request) => {
      const header = request.headers.get("authorization") ?? "";
      if (!header.startsWith("Bearer ")) return null;
      const token = header.slice(7).trim();
      // Power Keys and passes are the gateway's own business.
      if (token.startsWith("pfs_") || token.includes(".")) return null;
      return verifyToken(token);
    },
  });
  return {
    async handle(request: Request) {
      const path = new URL(request.url).pathname;
      // The sales page and its checkout belong to this gate as well.
      if (!READ_PATHS.includes(path) && !path.startsWith("/read/pass")) return null;
      return gateway.handle(request);
    },
  };
}
