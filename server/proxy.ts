import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Only our frontend may supply the original client address to the storage API. */
export function clientAddress(
  request: Request,
  fallback: string,
  secret?: string,
): string {
  const supplied = request.headers.get("x-readm3-proxy-secret");
  if (secret && supplied && timingSafeEqual(digest(secret), digest(supplied))) {
    return request.headers.get("x-readm3-client-ip") || fallback;
  }
  return fallback;
}

/** Keep browser cookies on the public origin while documents live on a volume. */
export function createApiProxy(upstream: string, secret: string) {
  const base = new URL(upstream);
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
    )
  ) {
    throw new Error(
      "READM3_API_UPSTREAM must use HTTPS (HTTP is allowed for localhost).",
    );
  }
  if (base.username || base.password || !secret)
    throw new Error(
      "Configure a proxy secret and an upstream without URL credentials.",
    );
  return async (request: Request, ip: string): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) return null;
    const headers = new Headers();
    for (const name of [
      "authorization",
      "cookie",
      "origin",
      "content-type",
      "accept",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("x-readm3-proxy-secret", secret);
    headers.set("x-readm3-client-ip", ip);
    try {
      const response = await fetch(new URL(url.pathname + url.search, base), {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      const resultHeaders = new Headers({
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      for (const name of ["content-type", "retry-after"]) {
        const value = response.headers.get(name);
        if (value) resultHeaders.set(name, value);
      }
      for (const cookie of response.headers.getSetCookie())
        resultHeaders.append("set-cookie", cookie);
      return new Response(response.body, {
        status: response.status,
        headers: resultHeaders,
      });
    } catch {
      return Response.json(
        {
          error:
            "Document storage is temporarily unavailable. Keep your draft and try again.",
        },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        },
      );
    }
  };
}
