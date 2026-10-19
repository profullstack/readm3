/**
 * readm3 as an OAuth 2.1 authorization server, so `readm3 login` signs a CLI in
 * as the person at the browser (@profullstack/auth-system/oauth2: authorization
 * code + PKCE S256 only, rotating refresh tokens, hashes only in the database).
 *
 *  - GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *  - GET  /oauth/authorize    consent page; signed-out browsers go through /account first
 *  - POST /oauth/authorize    Approve or Cancel, then back to the CLI's redirect_uri
 *  - GET  /oauth/cli          shows the code to paste when the CLI has no browser (SSH)
 *  - POST /oauth/token        authorization_code and refresh_token grants
 *  - POST /oauth/revoke       RFC 7009; ends the whole sign-in
 *
 * The CLI uses a loopback redirect when it can open a browser on the same machine,
 * and /oauth/cli otherwise, so a login started over SSH never lands on localhost.
 *
 * The desktop app signs in the same way (its window has no password manager, and an
 * emailed link opens in the browser), then trades its access token once for a
 * browser session in its own window:
 *  - POST /oauth/desktop-session   Bearer readm3-desktop token → session cookie value
 */
import type { Database } from "bun:sqlite";
import { createOAuthServer, OAuthError, type OAuthStore, type TokenRow } from "@profullstack/auth-system/oauth2";
import { SESSION_SECONDS, type Accounts } from "./accounts.ts";

export const CLI_CLIENT_ID = "readm3-cli";
export const DESKTOP_CLIENT_ID = "readm3-desktop";
const TOKEN_PREFIX = "r3"; // r3_at_…, r3_rt_… (OAUTH_ACCESS_PREFIX in accounts.ts)

const iso = (value: Date | string) => new Date(value).toISOString();

/** auth-system's storage interface over the readm3 SQLite database (OAUTH_SCHEMA). */
export function sqliteOAuthStore(db: Database): OAuthStore {
  const prune = () => {
    const stamp = new Date().toISOString();
    db.query("DELETE FROM oauth_codes WHERE expiresAt<=?").run(stamp);
    db.query("DELETE FROM oauth_tokens WHERE expiresAt<=?").run(stamp);
  };
  return {
    async saveCode(row) {
      prune();
      db.query("INSERT INTO oauth_codes (codeHash,userId,clientId,redirectUri,codeChallenge,scope,expiresAt) VALUES (?,?,?,?,?,?,?)")
        .run(row.codeHash, row.userId, row.clientId, row.redirectUri, row.codeChallenge, row.scope, iso(row.expiresAt));
    },
    async takeCode(codeHash) {
      // Single use: only the request that flips `used` gets the row.
      return (db.query("UPDATE oauth_codes SET used=1 WHERE codeHash=? AND used=0 RETURNING codeHash,userId,clientId,redirectUri,codeChallenge,scope,expiresAt")
        .get(codeHash) as Awaited<ReturnType<OAuthStore["takeCode"]>>) ?? null;
    },
    async saveToken(row) {
      db.query("INSERT INTO oauth_tokens (tokenHash,kind,userId,clientId,scope,familyId,expiresAt) VALUES (?,?,?,?,?,?,?)")
        .run(row.tokenHash, row.kind, row.userId, row.clientId, row.scope, row.familyId, iso(row.expiresAt));
    },
    async getToken(tokenHash) {
      const row = db.query("SELECT * FROM oauth_tokens WHERE tokenHash=?").get(tokenHash) as (TokenRow & { revoked: number; used: number }) | null;
      return row ? { ...row, revoked: !!row.revoked, used: !!row.used } : null;
    },
    async markUsed(tokenHash) {
      return db.query("UPDATE oauth_tokens SET used=1 WHERE tokenHash=? AND used=0 AND revoked=0").run(tokenHash).changes === 1;
    },
    async revokeFamily(familyId) {
      db.query("UPDATE oauth_tokens SET revoked=1 WHERE familyId=?").run(familyId);
    },
  };
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · readm3</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f5;color:#1b1b1b}
main{max-width:30rem;padding:2rem 1.25rem}h1{font-size:1.5rem;margin:0 0 .75rem}code{display:block;padding:.75rem;background:#fff;border:1px solid #ccc;border-radius:6px;word-break:break-all;user-select:all;font-size:.95rem}
form{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #1b1b1b;background:#fff;cursor:pointer}button[value=approve]{background:#1b1b1b;color:#fff}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}code{background:#222;border-color:#444}button{background:#222;color:#eee;border-color:#eee}button[value=approve]{background:#eee;color:#151515}}</style>
<main><h1>${escape(title)}</h1>${body}</main></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        // No form-action: Approve redirects to the CLI's loopback or /oauth/cli, and browsers apply form-action to that redirect.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

async function formBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const value = await request.json().catch(() => ({}));
    return value && typeof value === "object" ? (value as Record<string, string>) : {};
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

const AUTHORIZE_FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope"] as const;

export function createOAuth(accounts: Accounts) {
  const origin = accounts.origin;
  const oauth = createOAuthServer({
    store: sqliteOAuthStore(accounts.db),
    issuer: origin,
    tokenPrefix: TOKEN_PREFIX,
    clients: {
      [CLI_CLIENT_ID]: {
        name: "readm3 CLI",
        // Any port on 127.0.0.1 (RFC 8252), or the paste-a-code page for SSH sessions.
        redirectUris: ["http://127.0.0.1/callback", `${origin}/oauth/cli`],
      },
      [DESKTOP_CLIENT_ID]: {
        name: "the readm3 desktop app",
        redirectUris: ["http://127.0.0.1/callback"],
      },
    },
  });

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/.well-known/oauth-authorization-server" && request.method === "GET")
      return Response.json(oauth.metadata(), { headers: { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
    if (!path.startsWith("/oauth/")) return null;

    if (path === "/oauth/token" || path === "/oauth/revoke") {
      if (request.method !== "POST") return json({ error: "invalid_request", error_description: "Use POST." }, 405);
      const body = await formBody(request);
      try {
        if (path === "/oauth/revoke") {
          await oauth.revoke(body.token);
          return json({});
        }
        return json(await oauth.token(body));
      } catch (error) {
        if (error instanceof OAuthError) return json(error.toJSON(), error.status);
        throw error;
      }
    }

    if (path === "/oauth/desktop-session") {
      if (request.method !== "POST") return json({ error: "invalid_request", error_description: "Use POST." }, 405);
      const bearer = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
      // Only a token issued to the desktop app becomes a browser session; a CLI token never does.
      const grant = bearer ? await oauth.verifyAccessToken(bearer) : null;
      const user = grant?.clientId === DESKTOP_CLIENT_ID ? accounts.authenticate(bearer) : null;
      if (!user) return json({ error: "invalid_token", error_description: "Sign in again from the desktop app." }, 401);
      const session = accounts.startSession(user.id, "", "Desktop app");
      // The token has done its one job; the session cookie is what the window keeps.
      await oauth.revoke(bearer);
      return json({ name: accounts.cookieName, value: session, maxAge: SESSION_SECONDS });
    }

    if (path === "/oauth/cli" && request.method === "GET") {
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error || !code || !state)
        return page("Sign-in cancelled", "<p>Nothing was shared with the CLI. Run <strong>readm3 login</strong> again to start over.</p>", 400);
      return page(
        "Paste this code into your terminal",
        `<p>The terminal running <strong>readm3 login</strong> is waiting for it.</p><code>${escape(`${code}#${state}`)}</code><p>It works once and expires in 5 minutes.</p>`,
      );
    }

    if (path === "/oauth/authorize") {
      const fields = request.method === "POST" ? await formBody(request) : Object.fromEntries(url.searchParams);
      let params;
      try {
        params = oauth.validateAuthorize(fields);
      } catch (error) {
        // Never redirect to an unverified redirect_uri: show the problem here instead.
        if (error instanceof OAuthError) return page("This sign-in link is not valid", `<p>${escape(error.message)}.</p>`, 400);
        throw error;
      }
      const user = accounts.authenticate(accounts.token(request));

      if (request.method === "GET") {
        if (!user) {
          const next = `${path}${url.search}`;
          return Response.redirect(`${origin}/account?next=${encodeURIComponent(next)}`, 303);
        }
        const hidden = AUTHORIZE_FIELDS.filter((name) => fields[name] !== undefined)
          .map((name) => `<input type="hidden" name="${name}" value="${escape(String(fields[name]))}">`)
          .join("");
        const who = user.email ?? user.displayName;
        return page(
          `Sign in to ${params.clientName}?`,
          `<p><strong>${escape(params.clientName)}</strong> will be able to read and edit your readm3 documents as <strong>${escape(who)}</strong>.</p>
<p>Only approve if you just ${params.clientId === DESKTOP_CLIENT_ID ? "chose <strong>Sign in with your browser</strong> in the readm3 desktop app" : "ran <strong>readm3 login</strong>"} yourself.</p>
<form method="post" action="/oauth/authorize">${hidden}<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Cancel</button></form>`,
        );
      }

      if (request.method === "POST") {
        // Same-origin form posts only; the session cookie is SameSite=Lax as well.
        if (request.headers.get("origin") !== origin) return page("Request refused", "<p>Approve from the readm3 page itself.</p>", 403);
        if (!user) return Response.redirect(`${origin}/account`, 303);
        const target =
          fields.decision === "approve"
            ? await oauth.approve({ userId: user.id, clientId: params.clientId, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, scope: params.scope, state: params.state })
            : oauth.denyUrl(params);
        return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
      }
    }
    return null;
  };
}
