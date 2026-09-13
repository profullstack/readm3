import {
  Store,
  HttpError,
  checksum,
  id,
  now,
  secret,
  text,
  type User,
} from "./store.ts";
import { operate } from "./operations.ts";

const MAX_BODY = 1100 * 1024;
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
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json.");
  if (Number(request.headers.get("content-length")) > MAX_BODY)
    throw new HttpError(413, "Request too large.");
  const stream = request.body?.getReader();
  if (!stream) throw new HttpError(400, "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await stream.read();
      if (item.done) break;
      size += item.value.length;
      if (size > MAX_BODY) {
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
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new HttpError(400, "A JSON object is required.");
  }
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
function password(value: unknown) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw new HttpError(400, "Use a password between 12 and 256 characters.");
  return value;
}
function username(value: unknown) {
  const name = text(value, "Username", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(name))
    throw new HttpError(
      400,
      "Use 3–40 letters, numbers, underscores, or hyphens for your username.",
    );
  return name;
}
function token(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("readm3_session="))
      ?.slice(15) ?? ""
  );
}
function cookie(value: string, origin: string, maxAge = 2592000) {
  return `readm3_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}

export function createApi(store: Store, configuredOrigin?: string) {
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
      const credential = token(request);
      let user = credential ? store.authenticate(credential) : null;
      const path = url.pathname.slice(8);
      if (path === "me" && request.method === "GET") return json({ user });
      if (path.startsWith("auth/") && request.method === "POST") {
        limit(`auth:${ip}`);
        const args = await body(request);
        if (path === "auth/logout") {
          if (credential)
            store.run(
              "DELETE FROM sessions WHERE tokenHash=?",
              checksum(credential),
            );
          return json({ ok: true }, 200, {
            "set-cookie": cookie("", origin, 0),
          });
        }
        if (path === "auth/register") {
          const name = username(args.username);
          const pass = password(args.password);
          const displayName = text(
            args.displayName ?? name,
            "Display name",
            80,
          );
          if (store.get("SELECT id FROM users WHERE username=?", name))
            throw new HttpError(409, "That username is already taken.");
          const recoveryCode = secret();
          const userId = id();
          const stamp = now();
          const hash = await Bun.password.hash(pass, {
            algorithm: "argon2id",
            memoryCost: 19456,
            timeCost: 2,
          });
          try {
            store.db.transaction(() => {
              store.run(
                "INSERT INTO users VALUES (?,?,?,?,?,?,?)",
                userId,
                name,
                displayName,
                hash,
                checksum(recoveryCode),
                0,
                stamp,
              );
              const orgId = id();
              store.run(
                "INSERT INTO organizations VALUES (?,?,?)",
                orgId,
                `${displayName}'s workspace`,
                stamp,
              );
              store.run(
                "INSERT INTO members VALUES (?,?,?)",
                orgId,
                userId,
                "owner",
              );
            })();
          } catch (error) {
            if (String(error).includes("UNIQUE"))
              throw new HttpError(409, "That username is already taken.");
            throw error;
          }
          user = store.user(userId);
          const session = store.session(user);
          return json({ user, recoveryCode }, 201, {
            "set-cookie": cookie(session.token, origin),
          });
        }
        if (path === "auth/login") {
          const name = username(args.username);
          const pass =
            typeof args.password === "string" && args.password.length <= 256
              ? args.password
              : "";
          limit(`login:${name}`, 12);
          const account = store.get<{ id: string; passwordHash: string }>(
            "SELECT id,passwordHash FROM users WHERE username=?",
            name,
          );
          if (
            !account ||
            !(await Bun.password.verify(pass, account.passwordHash))
          )
            throw new HttpError(401, "Incorrect username or password.");
          user = store.user(account.id);
          const session = store.session(user);
          return json({ user }, 200, {
            "set-cookie": cookie(session.token, origin),
          });
        }
        if (path === "auth/recover") {
          const name = username(args.username);
          limit(`recovery:${name}`, 6);
          const code = text(args.recoveryCode, "Recovery code", 100);
          const account = store.get<{ id: string }>(
            "SELECT id FROM users WHERE username=? AND recoveryHash=?",
            name,
            checksum(code),
          );
          if (!account)
            throw new HttpError(401, "Incorrect username or recovery code.");
          const hash = await Bun.password.hash(password(args.password), {
            algorithm: "argon2id",
            memoryCost: 19456,
            timeCost: 2,
          });
          const recoveryCode = secret();
          store.db.transaction(() => {
            store.run(
              "UPDATE users SET passwordHash=?,recoveryHash=? WHERE id=?",
              hash,
              checksum(recoveryCode),
              account.id,
            );
            store.run("DELETE FROM sessions WHERE userId=?", account.id);
          })();
          user = store.user(account.id);
          const session = store.session(user);
          return json({ user, recoveryCode }, 200, {
            "set-cookie": cookie(session.token, origin),
          });
        }
        throw new HttpError(404, "Authentication action not found.");
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
          const args = await body(request);
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
      if (path === "actions" && request.method === "POST") {
        const data = await body(request);
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
              { orgId: url.searchParams.get("orgId") || undefined },
              origin,
            ),
          );
        if (request.method === "POST")
          return json(
            operate(
              store,
              user,
              "documents_create",
              await body(request),
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
          args = { ...(await body(request)), ...args };
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
