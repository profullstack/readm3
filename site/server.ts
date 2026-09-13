/**
 * Serves site/dist.
 *
 * Public pages stay static. Account APIs use verified email identities and
 * sessions persisted on the mounted database volume.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../server/accounts.ts";
import { accountMailer } from "../server/account-mail.ts";
import { Store } from "../server/store.ts";
import { createApi } from "../server/api.ts";

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

function cacheFor(path: string): string {
  if (path.endsWith("viewer-sw.js") || path.endsWith(".webmanifest")) return "no-cache";
  if (/\/viewer-assets\/[^/]+-[a-f0-9]{12}\./.test(path)) return "public, max-age=31536000, immutable";
  if (path.endsWith(".html")) return "public, max-age=0, must-revalidate";
  return "public, max-age=300";
}

export function serveSite(options: { accounts?: Accounts; port?: number; hostname?: string } = {}) {
  const listenPort = options.port ?? port;
  const accounts = options.accounts ?? new Accounts(
    process.env.READM3_DB || join(dirname(dist), "..", "data", "readm3.sqlite"),
    process.env.READM3_URL || (process.env.NODE_ENV === "production" ? "https://readm3.com" : `http://127.0.0.1:${listenPort}`),
    accountMailer(),
  );
  const store = new Store(accounts.db);
  const api = createApi(store, accounts.origin);
  return Bun.serve({
    port: listenPort,
    hostname: options.hostname ?? "0.0.0.0",
    maxRequestBodySize: 1100 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);

      // One canonical host. Railway issues a separate edge target and certificate
      // for www, so both hosts really do serve; send www to the apex rather than
      // leaving two origins for the same pages.
      const host = request.headers.get("host") ?? url.host;
      if (host.startsWith("www.")) {
        return Response.redirect(`https://${host.slice(4)}${url.pathname}${url.search}`, 308);
      }

      // Railway overwrites X-Real-IP at the edge; never trust client-supplied X-Forwarded-For.
      const ip = process.env.RAILWAY_ENVIRONMENT_ID
        ? request.headers.get("x-real-ip") || server.requestIP(request)?.address || "unknown"
        : server.requestIP(request)?.address || "unknown";
      const accountResponse = await accounts.handle(request, ip);
      if (accountResponse) return accountResponse;
      const documentResponse = await api(request, ip);
      if (documentResponse) return documentResponse;

      // One canonical path per page: /docs/ and /docs.html both settle on /docs.
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        return Response.redirect(`${url.origin}${url.pathname.slice(0, -1)}${url.search}`, 308);
      }

      const sharedPage = /^\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
      const file = resolve(sharedPage ? "/viewer" : url.pathname);
      if (!file) {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
      }

      const accountPage = file === join(dist, "account", "index.html") || url.pathname === "/admin";
      const privatePage = accountPage || sharedPage || url.pathname === "/viewer";
      return new Response(Bun.file(file), {
        headers: {
          "cache-control": privatePage ? "no-store" : cacheFor(file),
          "x-content-type-options": "nosniff",
          "referrer-policy": privatePage ? "no-referrer" : "strict-origin-when-cross-origin",
          ...(sharedPage ? { "x-robots-tag": "noindex, nofollow" } : {}),
          ...(accountPage ? {
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "x-frame-options": "DENY",
          } : {}),
        },
      });
    },
  });
}

if (import.meta.main) console.log(`readm3.com on :${serveSite().port}`);
