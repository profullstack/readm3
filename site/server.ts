/**
 * Serves site/dist.
 *
 * Public pages stay static. Account APIs use verified email identities and
 * sessions persisted on the mounted database volume.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { footerHtml } from "@profullstack/footer";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../server/accounts.ts";
import { accountMailer } from "../server/account-mail.ts";
import { Store } from "../server/store.ts";
import { createApi } from "../server/api.ts";
import { anthropicSummarizer, Billing, DEFAULT_MODEL, type Summarize } from "../server/billing.ts";
import { Payments, paymentOptions, type PaymentOptions } from "../server/payments.ts";
import { CoinPay } from "../server/coinpay.ts";
import { createOAuth } from "../server/oauth.ts";
import { createSyncApi } from "../server/sync-api.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PORT ?? 3000);

if (!existsSync(join(dist, "index.html"))) {
  console.error(`no build at ${dist}; run "bun run site:build" first`);
  process.exit(1);
}

/** A request path to a file inside dist, or null if it escapes or is missing. */
function resolve(pathname: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(dist, clean);
  if (candidate !== dist && !candidate.startsWith(dist + sep)) return null;

  for (const target of [candidate, join(candidate, "index.html"), `${candidate}.html`]) {
    if (existsSync(target) && statSync(target).isFile()) return target;
  }
  return null;
}

/*
 * The pit.world global footer (site name, search, ring, publish), appended as
 * the last thing in <body> of every site page. Fetched from pit.world with a 3s
 * timeout and cached an hour at module level; a failed refresh keeps serving the
 * last good copy, and with no copy the page is served unchanged.
 */
const PIT_FOOTER_URL = "https://pit.world/snippets/footer.html?site=readm3.com";
const PIT_FOOTER_TTL = 60 * 60 * 1000;
const pitFooter = { html: "", fetchedAt: 0, inflight: null as Promise<void> | null };

function refreshPitFooter(): Promise<void> {
  pitFooter.inflight ??= fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) })
    .then(async (res) => {
      const text = res.ok ? await res.text() : "";
      if (!text.includes("data-pit-footer")) throw new Error(`pit footer: HTTP ${res.status}`);
      pitFooter.html = text;
      pitFooter.fetchedAt = Date.now();
    })
    .catch(() => { pitFooter.fetchedAt = Date.now() - PIT_FOOTER_TTL + 60_000; }) // retry in a minute
    .finally(() => { pitFooter.inflight = null; });
  return pitFooter.inflight;
}

async function pitFooterHtml(): Promise<string> {
  if (!pitFooter.html) await refreshPitFooter();
  else if (Date.now() - pitFooter.fetchedAt > PIT_FOOTER_TTL) void refreshPitFooter();
  return pitFooter.html;
}

/*
 * The shared Profullstack footer (@profullstack/footer). site/build.ts bakes it
 * into each page and writes its options to dist/pfs-footer.json; here the baked
 * copy is swapped for one rendered from the package's @latest template (cached
 * an hour inside the package). Any failure keeps the baked copy.
 */
const footerOptionsFile = join(dist, "pfs-footer.json");
const footerOptions = existsSync(footerOptionsFile)
  ? (JSON.parse(readFileSync(footerOptionsFile, "utf8")) as Parameters<typeof footerHtml>[0])
  : null;
const BAKED_FOOTER = /<footer class="pfs-footer"[\s\S]*?<\/footer>/;

async function latestPfsFooter(html: string): Promise<string> {
  if (!footerOptions || !BAKED_FOOTER.test(html)) return html;
  try {
    const footer = await footerHtml(footerOptions);
    return html.replace(BAKED_FOOTER, () => footer);
  } catch {
    return html;
  }
}

async function pageBody(file: string, withPitFooter: boolean): Promise<{ body: BodyInit; type?: string }> {
  // The curl installer reads as text in a browser instead of downloading.
  if (file.endsWith(".sh")) return { body: Bun.file(file), type: "text/plain; charset=utf-8" };
  if (!withPitFooter || !file.endsWith(".html")) return { body: Bun.file(file) };
  const footer = await pitFooterHtml();
  const html = await latestPfsFooter(await Bun.file(file).text());
  const at = html.lastIndexOf("</body>");
  if (!footer || at < 0 || html.includes("data-pit-footer")) return { body: html, type: "text/html; charset=utf-8" };
  return { body: html.slice(0, at) + footer + html.slice(at), type: "text/html; charset=utf-8" };
}

function cacheFor(path: string): string {
  if (path.endsWith("viewer-sw.js") || path.endsWith(".webmanifest") || path.endsWith("/install.sh")) return "no-cache";
  if (/\/viewer-assets\/[^/]+-[a-z0-9]{8,12}\./.test(path)) return "public, max-age=31536000, immutable";
  if (path.endsWith(".html")) return "public, max-age=0, must-revalidate";
  return "public, max-age=300";
}

export function serveSite(options: { accounts?: Accounts; coinpay?: ConstructorParameters<typeof CoinPay>[2]; port?: number; hostname?: string; summarize?: Summarize | null; payments?: PaymentOptions } = {}) {
  const listenPort = options.port ?? port;
  const accounts = options.accounts ?? new Accounts(
    process.env.READM3_DB || join(dirname(dist), "..", "data", "readm3.sqlite"),
    process.env.READM3_URL || (process.env.NODE_ENV === "production" ? "https://readm3.com" : `http://127.0.0.1:${listenPort}`),
    accountMailer(),
  );
  const store = new Store(accounts.db);
  // COINPAY_OAUTH_CLIENT_ID/SECRET turn on Sign in with CoinPay; READM3_COINPAY_TRUSTED_CLIENTS lets apps call the API.
  // ANTHROPIC_API_KEY turns on paid AI summaries (READM3_SUMMARY_MODEL picks the model);
  // COINPAY_API_KEY, COINPAY_BUSINESS_ID and COINPAY_WEBHOOK_SECRET open top-ups.
  const model = process.env.READM3_SUMMARY_MODEL || DEFAULT_MODEL;
  const summarize = options.summarize !== undefined ? options.summarize
    : process.env.ANTHROPIC_API_KEY ? anthropicSummarizer(process.env.ANTHROPIC_API_KEY, model) : null;
  const billing = new Billing(store, summarize, model);
  const payments = new Payments(store, billing, options.payments ?? paymentOptions());
  const api = createApi(store, accounts.origin, new CoinPay(store, accounts, options.coinpay), { billing, payments });
  const syncApi = createSyncApi(store, accounts);
  // `readm3 login`: OAuth 2.1 for the CLI (server/oauth.ts).
  const oauth = createOAuth(accounts);
  return Bun.serve({
    port: listenPort,
    hostname: options.hostname ?? "0.0.0.0",
    maxRequestBodySize: 40 * 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);

      // One canonical host. Railway issues a separate edge target and certificate
      // for www, so both hosts really do serve; send www to the apex rather than
      // leaving two origins for the same pages.
      const host = request.headers.get("host") ?? url.host;
      if (host.startsWith("www.")) {
        return Response.redirect(`https://${host.slice(4)}${url.pathname}${url.search}`, 308);
      }

      // Health check for status.profullstack.com: the process serves and the database answers.
      if (url.pathname === "/api/health" && request.method === "GET") {
        const headers = { "cache-control": "no-store" };
        try {
          accounts.db.query("SELECT 1").get();
          return Response.json({ status: "ok", db: "ok" }, { headers });
        } catch {
          return Response.json({ status: "error", db: "down" }, { status: 503, headers });
        }
      }

      // Railway overwrites X-Real-IP at the edge; never trust client-supplied X-Forwarded-For.
      const ip = process.env.RAILWAY_ENVIRONMENT_ID
        ? request.headers.get("x-real-ip") || server.requestIP(request)?.address || "unknown"
        : server.requestIP(request)?.address || "unknown";
      const accountResponse = await accounts.handle(request, ip);
      if (accountResponse) return accountResponse;
      const oauthResponse = await oauth(request);
      if (oauthResponse) return oauthResponse;
      const syncResponse = await syncApi(request);
      if (syncResponse) return syncResponse;
      const documentResponse = await api(request, ip);
      if (documentResponse) return documentResponse;

      // One canonical path per page: /docs/ and /docs.html both settle on /docs.
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        return Response.redirect(`${url.origin}${url.pathname.slice(0, -1)}${url.search}`, 308);
      }

      // /p/<token>/raw is the paste's text, the address a curl or a "Raw" link wants.
      const rawPaste = url.pathname.match(/^\/p\/([A-Za-z0-9_-]{43})\/raw$/);
      if (rawPaste) {
        const target = `${url.origin}/api/v1/pastes/${rawPaste[1]}/raw${url.search}`;
        return (await api(new Request(target, { method: request.method, headers: request.headers }), ip))!;
      }

      const sharedPage = /^\/(s|p)\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
      const file = resolve(sharedPage ? "/viewer" : url.pathname);
      if (!file) {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
      }

      const accountPage = file === join(dist, "account", "index.html") || url.pathname === "/admin";
      const privatePage = accountPage || sharedPage || url.pathname === "/viewer";
      // The editor, workspaces and shared documents are full-screen app shells; every other page gets the global footer.
      const appShell = sharedPage || url.pathname === "/viewer" || url.pathname === "/admin";
      const page = await pageBody(file, !appShell);
      return new Response(page.body, {
        headers: {
          ...(page.type ? { "content-type": page.type } : {}),
          "cache-control": privatePage ? "no-store" : cacheFor(file),
          "x-content-type-options": "nosniff",
          "referrer-policy": privatePage ? "no-referrer" : "strict-origin-when-cross-origin",
          ...(sharedPage ? { "x-robots-tag": "noindex, nofollow" } : {}),
          ...(accountPage ? {
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "x-frame-options": "DENY",
          } : {}),
        },
      });
    },
  });
}

if (import.meta.main) console.log(`readm3.com on :${serveSite().port}`);
