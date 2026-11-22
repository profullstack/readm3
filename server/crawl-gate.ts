/**
 * The crawl door: AI training crawlers, headless browsers and SEO scrapers buy a
 * day pass ($1 a day over x402, or any coin / PayPal through CoinPay's hosted
 * checkout) on /crawl, and get a 402 everywhere else. People, verified search
 * crawlers, AI chat/search fetchers and signed-in users are never charged, and
 * the API and OAuth endpoints are never metered. Built only with a scoped key
 * and a payee (separate from the top-up COINPAY_API_KEY), so a local or
 * self-hosted server never sells.
 */
import { createGateway } from "@profullstack/x402-gateway";
import { coinpayFetch } from "./coinpay-ua.ts";

export type CrawlGate = { handle: (request: Request) => Promise<Response | null> };

export function createCrawlGate(
  env: Record<string, string | undefined> = process.env,
  /** Whether a session token is live: true, or anything else (not a session). Same check as server/read-gate.ts. */
  verifyToken: (token: string) => boolean | null = () => null,
): CrawlGate | null {
  const apiKey = env.COINPAY_X402_KEY ?? "";
  const payTo = env.CRAWL_PAY_TO ?? "";
  if (!apiKey || !payTo) return null;
  return createGateway({
    siteUrl: (env.READM3_URL || "https://readm3.com").replace(/\/+$/, ""),
    siteName: "readm3",
    coinpay: { apiKey },
    payTo,
    // x402-gateway 0.16 has no User-Agent of its own; this names the app to CoinPay.
    fetch: coinpayFetch,
    contact: "mailto:anthony@profullstack.com",
    // The legal pages stay readable by every crawler: a connector directory's review bot reads them.
    openPaths: ["/api/", "/oauth/", "/llms.txt", "/privacy", "/terms", "/privacy/", "/terms/", "/privacy.html", "/terms.html"],
    // A signed-in browser, verified: a made-up cookie must not open the site to a
    // crawler. Until 2026-11-22 this only tested that the cookie's name was present,
    // so GPTBot with `Cookie: readm3_session=x` read free.
    exempt: (request: Request) => {
      const session = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)(?:__Host-)?readm3_session=([^;]+)/)?.[1];
      return Boolean(session && verifyToken(session) === true);
    },
  });
}
