import { createProfileHandlers } from "@profullstack/profile";
import { profiles } from "./profile.ts";
import { Store, HttpError, MAX_BINARY_SOURCE, checksum, now, text, type User } from "./store.ts";
import { type CoinPay, isCoinPayToken } from "./coinpay.ts";
import { operate } from "./operations.ts";
import { createPaste, deletePaste, readPaste } from "./pastes.ts";
import { binaryType } from "../src/code.ts";
import type { Billing } from "./billing.ts";
import { PACKS_USD, type Payments } from "./payments.ts";

/** Paid AI summaries and the CoinPay top-ups that fund them. */
export type Money = { billing: Billing; payments: Payments };

const MAX_BODY = 1100 * 1024;
/** A document write: a shared PDF or image's base64 (server/store.ts) with room for the JSON around it. */
const MAX_DOCUMENT_BODY = MAX_BINARY_SOURCE + 64 * 1024;
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const json = (
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) => Response.json(body, { status, headers: { ...headers, ...extra } });
/** A file sent for a summary: up to 20 MB as base64, with room for the JSON around it. */
const MAX_SUMMARY_BODY = 28 * 1024 * 1024;
/** Ask AI: 400 KB of file text plus paths, the question and the turns before it, JSON-escaped. */
const MAX_ASK_BODY = 2 * 1024 * 1024;
async function body(request: Request, max = MAX_BODY): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json.");
  const bytes = await readBytes(request, max);
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new HttpError(400, "A JSON object is required.");
  }
}
/**
 * A paste sent as the file itself: an upload (`curl -F file=@app.log`), whose file
 * name is the title, or the bare bytes (`curl --data-binary @app.log`). Title,
 * expiresIn and language come from the query string or the form's other fields. A
 * PDF or image becomes the base64 a JSON paste would carry; anything else is UTF-8.
 */
async function filePaste(request: Request, url: URL): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  for (const key of ["title", "expiresIn", "language"])
    if (url.searchParams.has(key)) args[key] = url.searchParams.get(key);
  let bytes: Uint8Array;
  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    if (Number(request.headers.get("content-length")) > MAX_BODY)
      throw new HttpError(413, "Request too large.");
    const form = await request.formData().catch(() => {
      throw new HttpError(400, "The upload could not be read.");
    });
    let file: File | undefined;
    for (const [key, value] of form) {
      if (typeof value !== "string") file ??= value;
      else if (["title", "expiresIn", "language"].includes(key)) args[key] ??= value;
    }
    if (!file) throw new HttpError(400, "Send the file as a form field: -F file=@app.log");
    if (file.size > MAX_BODY) throw new HttpError(413, "Request too large.");
    if (args.title === undefined && file.name) args.title = file.name;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else bytes = await readBytes(request, MAX_BODY);
  const title = typeof args.title === "string" ? args.title : undefined;
  args.source = binaryType(title)
    ? Buffer.from(bytes).toString("base64")
    : new TextDecoder().decode(bytes);
  return args;
}
async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > max)
    throw new HttpError(413, "Request too large.");
  const stream = request.body?.getReader();
  if (!stream) throw new HttpError(400, "A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await stream.read();
      if (item.done) break;
      size += item.value.length;
      if (size > max) {
        await stream.cancel();
        throw new HttpError(413, "Request too large.");
      }
      chunks.push(item.value);
    }
  } finally {
    stream.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
const buckets = new Map<string, { count: number; until: number }>();
function limit(key: string, max = 30) {
  const stamp = Date.now();
  if (buckets.size > 10000)
    for (const [k, v] of buckets) if (v.until < stamp) buckets.delete(k);
  let bucket = buckets.get(key);
  if (!bucket || bucket.until < stamp) {
    bucket = { count: 0, until: stamp + 60000 };
    buckets.set(key, bucket);
  }
  if (++bucket.count > max)
    throw new HttpError(429, "Too many requests. Try again in a minute.");
}
function token(request: Request, origin: string) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  const name = origin.startsWith("https:")
    ? "__Host-readm3_session"
    : "readm3_session";
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
export function createApi(
  store: Store,
  configuredOrigin?: string,
  coinpay?: CoinPay,
  money?: Money,
) {
  return async (request: Request, ip = "local"): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/v1/")) return null;
    const origin = configuredOrigin || url.origin;
    try {
      // Cookie and bearer clients use the same permission layer. Browser writes
      // must originate here; capability links are never accepted as login tokens.
      const sentOrigin = request.headers.get("origin");
      if (sentOrigin && sentOrigin !== origin)
        throw new HttpError(403, "Cross-origin API requests are not allowed.");
      const credential = token(request, origin);
      let user: User | null = null;
      // A trusted CoinPay app calls with the access token CoinPay issued it, which
      // is a JWT; readm3's own tokens never contain a dot.
      if (
        coinpay &&
        request.headers.get("authorization")?.startsWith("Bearer ") &&
        isCoinPayToken(credential)
      ) {
        // Each uncached token costs a userinfo call to CoinPay; cap them per address.
        limit(`coinpay-bearer:${ip}`, 300);
        user = (await coinpay.bearer(credential)).user;
      }
      else user = credential ? store.authenticate(credential) : null;
      if (user) store.ensureWorkspace(user);
      const path = url.pathname.slice(8);
      if (path === "me" && request.method === "GET") return json({ user });
      // The shared @profullstack/profile fields; private to the signed-in account.
      if (path === "me/profile") {
        const method = request.method as "GET" | "PUT" | "PATCH";
        if (!["GET", "PUT", "PATCH"].includes(method)) throw new HttpError(405, "Method not allowed.");
        if (method !== "GET" && request.headers.has("cookie") && !request.headers.has("authorization") && !sentOrigin)
          throw new HttpError(403, "Browser writes require a same-origin Origin header.");
        const handlers = createProfileHandlers({
          store: await profiles(store.db).ready,
          getUser: () => user && {
            id: user.id,
            email: store.get<{ email: string }>("SELECT email FROM account_emails WHERE userId=?", user.id)?.email ?? null,
          },
        });
        return handlers[method](request);
      }
      // CoinPay's webhook: no session, the signature over the raw body is the credential.
      if (path === "billing/coinpay/webhook" && request.method === "POST") {
        if (!money) throw new HttpError(404, "API route not found.");
        limit(`coinpay-webhook:${ip}`, 120);
        const signature = request.headers.get("x-coinpay-signature") ?? request.headers.get("coinpay-signature") ?? request.headers.get("x-webhook-signature");
        return json(money.payments.webhook(await request.text(), signature));
      }
      if (path.startsWith("auth/"))
        throw new HttpError(410, "Sign in with a verified email at /account.");
      if (path.startsWith("coinpay/")) {
        if (!coinpay) {
          if (path === "coinpay/status") return json({ enabled: false, identities: [], canUnlink: false });
          throw new HttpError(503, "Sign in with CoinPay is not configured on this server.");
        }
        if (path.startsWith("coinpay/oauth/")) limit(`coinpay:${ip}`, 30);
        if (
          request.method !== "GET" &&
          request.headers.has("cookie") &&
          !request.headers.has("authorization") &&
          !sentOrigin
        )
          throw new HttpError(403, "Browser writes require a same-origin Origin header.");
        const handled = await coinpay.route(request, path, user, origin, () => body(request));
        if (handled) return handled;
        throw new HttpError(404, "API route not found.");
      }
      // A share link's six-digit voice code opens the document read-only. A code is short
      // enough to guess, so lookups are few per address.
      const code = path.match(/^codes\/(\d{6})$/);
      if (code) {
        if (request.method !== "GET") throw new HttpError(405, "Document codes are read-only.");
        limit(`code:${ip}`, 20);
        return json(store.viewByCode(code[1]!));
      }
      const shared = path.match(/^shared\/([A-Za-z0-9_-]{43})$/);
      if (shared) {
        const link = store.get<{
          documentId: string;
          versionId: string | null;
          role: string;
        }>(
          "SELECT documentId,versionId,role FROM shares WHERE tokenHash=? AND (expiresAt IS NULL OR expiresAt>?)",
          checksum(shared[1]),
          now(),
        );
        if (!link)
          throw new HttpError(
            404,
            "This link is invalid, expired, or revoked.",
          );
        if (request.method === "GET") {
          const view = store.view(
            user,
            link.documentId,
            link.versionId ?? undefined,
            shared[1],
          );
          return json({
            ...view,
            canEdit: !link.versionId && view.canEdit,
            sharedRole: link.role,
            pinned: !!link.versionId,
          });
        }
        if (request.method === "PATCH") {
          limit(`share-write:${ip}`, 60);
          if (link.versionId)
            throw new HttpError(403, "This link grants viewing only.");
          // Existing account permissions still apply when following a view link.
          // The capability itself only grants the role selected by its owner.
          store.document(user, link.documentId, "edit", shared[1]);
          const args = await body(request, MAX_DOCUMENT_BODY);
          if (
            Object.keys(args).some(
              (k) => !["source", "title", "baseVersion"].includes(k),
            )
          )
            throw new HttpError(
              403,
              "Edit links cannot change ownership or permissions.",
            );
          return json(
            store.updateDocument(user, link.documentId, args, shared[1]),
          );
        }
        throw new HttpError(
          405,
          "Shared links support reading and permitted edits only.",
        );
      }
      // Anonymous pastes: no account, the link is the capability. Created, read and
      // deleted by whoever holds the token; never listed.
      const paste = path.match(/^pastes(?:\/([A-Za-z0-9_-]{43})(\/raw)?)?$/);
      if (paste) {
        if (!paste[1] && request.method === "POST") {
          limit(`paste-create:${ip}`, 10);
          const created = createPaste(
            store,
            request.headers.get("content-type")?.startsWith("application/json")
              ? await body(request)
              : await filePaste(request, url),
          );
          return json(
            {
              id: created.id,
              url: `${origin}/p/${created.token}`,
              raw: `${origin}/p/${created.token}/raw`,
              title: created.title,
              language: created.language,
              mime: created.mime,
              createdAt: created.createdAt,
              expiresAt: created.expiresAt,
              bytes: created.bytes,
              sensitive: created.sensitive,
            },
            201,
          );
        }
        if (paste[1] && request.method === "GET") {
          limit(`paste-read:${ip}`, 120);
          const found = readPaste(store, paste[1]);
          if (!paste[2]) return json(found);
          // The raw text. Shown in the browser it is always text/plain, never the
          // language's own type: an HTML or SVG paste rendered on this origin would
          // run as this site. The download carries the real type, as an attachment.
          const download = url.searchParams.get("download") === "1";
          const filename = `filename*=UTF-8''${encodeURIComponent(found.title)}`;
          // A PDF or image paste is stored as base64; its real bytes go out. A PDF or
          // raster image is safe to show inline; SVG can carry script, so it is plain text.
          const binary = binaryType(found.title);
          const body = binary ? Buffer.from(found.source, "base64") : found.source;
          const inlineType = binary && binary.mime !== "image/svg+xml" ? binary.mime : "text/plain; charset=utf-8";
          return new Response(body, {
            headers: {
              ...headers,
              "content-type": download ? found.mime : inlineType,
              "content-disposition": download ? `attachment; ${filename}` : `inline; ${filename}`,
              "content-security-policy": "default-src 'none'; sandbox",
              "x-robots-tag": "noindex, nofollow",
            },
          });
        }
        if (paste[1] && request.method === "DELETE") {
          limit(`paste-write:${ip}`, 30);
          deletePaste(store, paste[1]);
          return json({ deleted: true });
        }
        throw new HttpError(
          405,
          "A paste is created with POST, and read or deleted by its link.",
        );
      }
      if (!user)
        throw new HttpError(401, "Sign in or provide a personal API token.");
      limit(`user:${user.id}`, 300);
      if (
        request.method !== "GET" &&
        request.headers.has("cookie") &&
        !request.headers.has("authorization") &&
        !sentOrigin
      )
        throw new HttpError(
          403,
          "Browser writes require a same-origin Origin header.",
        );
      if (money && path.startsWith("billing")) {
        if (path === "billing" && request.method === "GET")
          return json({ ...money.billing.account(user), topups: money.payments.enabled, packs: PACKS_USD });
        if (path === "billing/topups" && request.method === "POST") {
          limit(`topup:${user.id}`, 10);
          return json(await money.payments.topup(user, await body(request), origin), 201);
        }
        const topup = path.match(/^billing\/topups\/([A-Za-z0-9_-]{1,64})$/);
        if (topup && request.method === "GET") return json(money.payments.status(user, topup[1]!));
        if (path === "billing/experiment" && request.method === "GET") {
          if (!user.admin) throw new HttpError(403, "Admins only.");
          return json({ arms: money.billing.experiment() });
        }
        throw new HttpError(404, "API route not found.");
      }
      if (money && path === "summaries" && request.method === "POST") {
        limit(`summary:${user.id}`, 30);
        return json(await money.billing.summary(user, await body(request)));
      }
      if (money && path === "ask" && request.method === "POST") {
        limit(`ask:${user.id}`, 30);
        return json(await money.billing.ask(user, await body(request, MAX_ASK_BODY)));
      }
      if (money && path === "summaries/document" && request.method === "POST") {
        limit(`summary:${user.id}`, 30);
        return json(await money.billing.documentSummary(user, await body(request, MAX_SUMMARY_BODY)));
      }
      // A kept summary read aloud, as MP3; the charge and the new balance travel as headers.
      const speech = path.match(/^summaries\/([A-Za-z0-9_-]{1,64})\/speech$/);
      if (money && speech && request.method === "POST") {
        limit(`listen:${user.id}`, 30);
        const heard = await money.billing.listen(user, speech[1]!);
        return new Response(heard.audio as Uint8Array<ArrayBuffer>, {
          headers: { ...headers, "content-type": "audio/mpeg", "x-charged-micros": String(heard.chargedMicros), "x-balance-micros": String(heard.balanceMicros) },
        });
      }
      if (path === "actions" && request.method === "POST") {
        const data = await body(request, MAX_DOCUMENT_BODY);
        const args = data.args ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new HttpError(400, "args must be an object.");
        return json(
          operate(
            store,
            user,
            text(data.operation, "Operation"),
            args as Record<string, unknown>,
            origin,
          ),
        );
      }
      if (path === "documents") {
        if (request.method === "GET")
          return json(
            operate(
              store,
              user,
              "documents_list",
              {
                orgId: url.searchParams.get("orgId") || undefined,
                search: url.searchParams.get("search") || undefined,
                limit: url.searchParams.get("limit") ?? undefined,
                offset: url.searchParams.get("offset") ?? undefined,
              },
              origin,
            ),
          );
        if (request.method === "POST")
          return json(
            operate(
              store,
              user,
              "documents_create",
              await body(request, MAX_DOCUMENT_BODY),
              origin,
            ),
            201,
          );
      }
      const doc = path.match(
        /^documents\/([\w-]+)(?:\/(versions|shares|permissions)(?:\/([\w-]+))?)?$/,
      );
      if (doc) {
        let op: string | undefined;
        let args: Record<string, unknown> = { documentId: doc[1] };
        if (!doc[2])
          op = (
            {
              GET: "documents_get",
              PATCH: "documents_update",
              DELETE: "documents_delete",
            } as Record<string, string>
          )[request.method];
        else if (doc[2] === "versions")
          op =
            request.method === "GET"
              ? doc[3]
                ? "versions_get"
                : "versions_list"
              : undefined;
        else if (doc[2] === "shares")
          op = (
            {
              GET: "shares_list",
              POST: "shares_create",
              DELETE: "shares_revoke",
            } as Record<string, string>
          )[request.method];
        else if (doc[2] === "permissions")
          op = (
            {
              GET: "permissions_list",
              POST: "permissions_set",
              DELETE: "permissions_remove",
            } as Record<string, string>
          )[request.method];
        if (doc[3])
          args = {
            ...args,
            versionId: doc[3],
            shareId: doc[3],
            userId: doc[3],
          };
        if (["POST", "PATCH"].includes(request.method))
          args = { ...(await body(request, MAX_DOCUMENT_BODY)), ...args };
        if (op) return json(operate(store, user, op, args, origin));
      }
      throw new HttpError(404, "API route not found.");
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          { error: error.message, ...error.details },
          error.status,
          error.status === 429 ? { "retry-after": "60" } : {},
        );
      console.error(
        "readm3 API error",
        error instanceof Error ? error.message : "Unknown error",
      );
      return json(
        { error: "The server could not complete this request." },
        500,
      );
    }
  };
}
