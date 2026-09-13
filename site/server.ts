/**
 * Serves site/dist.
 *
 * Serves the public site plus authenticated document and organization APIs. It binds
 * the port Railway injects, answers `/` for the healthcheck, and keeps HTML
 * uncacheable so a deploy is visible immediately rather than after a TTL.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../server/store.ts";
import { createApi } from "../server/api.ts";
import { clientAddress, createApiProxy } from "../server/proxy.ts";

const dist = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PORT ?? 3000);
const api = process.env.READM3_API_UPSTREAM
  ? createApiProxy(process.env.READM3_API_UPSTREAM, process.env.READM3_PROXY_SECRET || "")
  : createApi(new Store(process.env.READM3_DB || join(dirname(dist), "..", "data", "readm3.sqlite")), process.env.READM3_URL);

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

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  maxRequestBodySize: 1100 * 1024,
  async fetch(request) {
    const url = new URL(request.url);

    // One canonical host. Railway issues a separate edge target and certificate
    // for www, so both hosts really do serve; send www to the apex rather than
    // leaving two origins for the same pages.
    const host = request.headers.get("host") ?? url.host;
    if (host.startsWith("www.")) {
      return Response.redirect(`https://${host.slice(4)}${url.pathname}${url.search}`, 308);
    }

    // One canonical path per page: /docs/ and /docs.html both settle on /docs.
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      return Response.redirect(`${url.origin}${url.pathname.slice(0, -1)}${url.search}`, 308);
    }

    const edgeAddress = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || server.requestIP(request)?.address || "unknown";
    const response = await api(request, clientAddress(request, edgeAddress, process.env.READM3_PROXY_SECRET));
    if (response) return response;
    const sharedPage = /^\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
    const file = resolve(sharedPage ? "/viewer" : url.pathname);
    if (!file) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }

    return new Response(Bun.file(file), {
      headers: {
        "cache-control": cacheFor(file),
        "x-content-type-options": "nosniff",
        "referrer-policy": sharedPage || url.pathname === "/viewer" || url.pathname === "/admin" ? "no-referrer" : "strict-origin-when-cross-origin",
        ...(sharedPage ? { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } : {}),
      },
    });
  },
});

console.log(`readm3.com on :${server.port}`);
