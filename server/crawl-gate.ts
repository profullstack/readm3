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

export type CrawlGate = { handle: (request: Request) => Promise<Response | null> };

export function createCrawlGate(env: Record<string, string | undefined> = process.env): CrawlGate | null {
  const apiKey = env.COINPAY_X402_KEY ?? "";
  const payTo = env.CRAWL_PAY_TO ?? "";
  if (!apiKey || !payTo) return null;
  return createGateway({
    siteUrl: (env.READM3_URL || "https://readm3.com").replace(/\/+$/, ""),
    siteName: "readm3",
    coinpay: { apiKey },
    payTo,
    contact: "mailto:anthony@profullstack.com",
    openPaths: ["/api/", "/oauth/", "/llms.txt"],
    exempt: (request: Request) => /(?:^|;\s*)(?:__Host-)?readm3_session=/.test(request.headers.get("cookie") ?? ""),
  });
}
