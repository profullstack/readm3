/**
 * CoinPay (coinpayportal.com) as an identity provider, two ways.
 *
 *  - People sign in with CoinPay on the web (authorization code + PKCE S256) or
 *    from the CLI, which runs the same grant against a loopback redirect and has
 *    readm3 exchange the code for a readm3 API token.
 *  - Apps CoinPay has issued tokens to may call the API with that token as their
 *    bearer, when their client_id is on READM3_COINPAY_TRUSTED_CLIENTS. CoinPay
 *    signs its access tokens with a secret only CoinPay holds, so a token is
 *    verified by asking CoinPay's userinfo who it belongs to; nothing in the JWT
 *    is read until that call succeeds.
 *
 * A CoinPay account maps to one readm3 user through user_identities. CoinPay's
 * userinfo always reports email_verified false, so its email never joins a
 * CoinPay identity to an existing account and never becomes an account email:
 * an identity that is not linked yet is a new user, never a merge.
 */
import type { Accounts } from "./accounts.ts";
import {
  Store,
  HttpError,
  checksum,
  equalSecret,
  id,
  now,
  secret,
  type User,
} from "./store.ts";
import { createHash } from "node:crypto";

export const COINPAY_SCOPES = "openid profile email";
const PROVIDER = "coinpay";
/** An authorization has this long to come back. */
const STATE_SECONDS = 600;
/** Longest a trusted-app token is believed without asking CoinPay again. */
const CACHE_MS = 5 * 60_000;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/;
const JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;

export type CoinPayOptions = {
  clientId?: string;
  clientSecret?: string;
  /** Default https://coinpayportal.com. */
  url?: string;
  /** CoinPay client_ids whose access tokens the API accepts as bearers. */
  trustedClients?: string[];
};
export type Identity = {
  provider: string;
  providerUserId: string;
  email: string | null;
  createdAt: string;
  lastUsedAt: string;
};
type UserInfo = { sub: string; name: string | null; email: string | null };

export function coinpayOptions(env = process.env): CoinPayOptions {
  return {
    clientId: env.COINPAY_OAUTH_CLIENT_ID || undefined,
    clientSecret: env.COINPAY_OAUTH_CLIENT_SECRET || undefined,
    url: env.COINPAY_URL || undefined,
    trustedClients: (env.READM3_COINPAY_TRUSTED_CLIENTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}
/** A token that is shaped like a JWT, which a readm3 token (43 base64url characters) never is. */
export const isCoinPayToken = (token: string) => JWT.test(token);
const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const pkce = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
function claims(token: string): Record<string, unknown> {
  try {
    const value = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    );
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export class CoinPay {
  readonly url: string;
  readonly clientId: string | null;
  private clientSecret: string | null;
  readonly trusted: Set<string>;
  private cache = new Map<
    string,
    { userId: string; clientId: string; until: number }
  >();
  constructor(
    private store: Store,
    private accounts: Accounts,
    options: CoinPayOptions = coinpayOptions(),
  ) {
    this.url = (options.url || "https://coinpayportal.com").replace(/\/+$/, "");
    this.clientId = options.clientId || null;
    this.clientSecret = options.clientSecret || null;
    this.trusted = new Set(options.trustedClients ?? []);
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS coinpay_oauth_states (stateHash TEXT PRIMARY KEY, verifier TEXT NOT NULL, next TEXT, expiresAt TEXT NOT NULL)",
    );
  }
  /** Sign-in needs both halves of the client credential; without them the button is hidden and the routes answer 503. */
  get enabled() {
    return !!this.clientId && !!this.clientSecret;
  }
  private require() {
    if (!this.enabled)
      throw new HttpError(503, "Sign in with CoinPay is not configured on this server.");
  }
  private async call(path: string, init: RequestInit) {
    let response: Response;
    try {
      response = await fetch(`${this.url}/api/oauth/${path}`, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, "CoinPay is not answering. Try again in a minute.");
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === "object") body = parsed;
    } catch {
      /* An HTML error page: the status says enough. */
    }
    return { status: response.status, body };
  }
  /** The authorization code, traded for an access token with this server's client secret. */
  private async exchange(code: string, redirectUri: string, verifier: string) {
    const result = await this.call("token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: this.clientId!,
        client_secret: this.clientSecret!,
      }).toString(),
    });
    const token = str(result.body.access_token);
    if (result.status !== 200 || !token)
      throw new HttpError(
        400,
        `CoinPay refused the sign-in: ${str(result.body.error_description) ?? str(result.body.error) ?? `HTTP ${result.status}`}.`,
      );
    return token;
  }
  private async userinfo(token: string): Promise<UserInfo> {
    const result = await this.call("userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    const sub = str(result.body.sub);
    if (result.status !== 200 || !sub)
      throw new HttpError(
        401,
        "CoinPay did not accept this access token. It may have expired; get a new one.",
      );
    // email_verified is always false on CoinPay. The address is kept for display only.
    return { sub, name: str(result.body.name), email: str(result.body.email) };
  }
  identities(userId: string): Identity[] {
    return this.store.all<Identity>(
      "SELECT provider,providerUserId,email,createdAt,lastUsedAt FROM user_identities WHERE userId=? ORDER BY createdAt",
      userId,
    );
  }
  private event(
    userId: string,
    sub: string,
    event: "link" | "unlink" | "signin" | "api",
    clientId: string | null = null,
  ) {
    this.store.run(
      "INSERT INTO identity_events VALUES (?,?,?,?,?,?,?)",
      id(),
      userId,
      PROVIDER,
      sub,
      event,
      clientId,
      now(),
    );
  }
  /** The readm3 user for a CoinPay account, created (with its personal workspace) the first time it is seen. */
  private provision(info: UserInfo, event: "signin" | "api", clientId: string | null = null): User {
    const userId = this.store.db.transaction(() => {
      const found = this.store.get<{ userId: string }>(
        "SELECT userId FROM user_identities WHERE provider=? AND providerUserId=?",
        PROVIDER,
        info.sub,
      );
      if (found) {
        this.store.run(
          "UPDATE user_identities SET lastUsedAt=?,email=? WHERE provider=? AND providerUserId=?",
          now(),
          info.email,
          PROVIDER,
          info.sub,
        );
        this.event(found.userId, info.sub, event, clientId);
        return found.userId;
      }
      const created = id();
      const name =
        (info.name ?? info.email?.split("@")[0] ?? "")
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
          .slice(0, 80) || "CoinPay user";
      // No password, recovery code or account email: the CoinPay account is the credential.
      this.store.run(
        "INSERT INTO users (id,username,displayName,passwordHash,recoveryHash,admin,createdAt) VALUES (?,?,?,?,?,0,?)",
        created,
        `user_${created.toLowerCase()}`,
        name,
        "!coinpay-login-only",
        checksum(secret()),
        now(),
      );
      this.insertIdentity(created, info);
      this.event(created, info.sub, event, clientId);
      return created;
    })();
    const user = this.store.user(userId);
    this.store.ensureWorkspace(user);
    return user;
  }
  private insertIdentity(userId: string, info: UserInfo) {
    this.store.run(
      "INSERT INTO user_identities VALUES (?,?,?,?,?,?,?)",
      id(),
      userId,
      PROVIDER,
      info.sub,
      info.email,
      now(),
      now(),
    );
    this.event(userId, info.sub, "link");
  }
  /** Attach a CoinPay account to a signed-in user. Never moves an identity between users. */
  private link(user: { id: string }, info: UserInfo) {
    this.store.db.transaction(() => {
      const found = this.store.get<{ userId: string }>(
        "SELECT userId FROM user_identities WHERE provider=? AND providerUserId=?",
        PROVIDER,
        info.sub,
      );
      if (found && found.userId !== user.id)
        throw new HttpError(
          409,
          "That CoinPay account is already linked to a different readm3 account. Sign in with CoinPay to use that account, or unlink it there first.",
        );
      if (found) {
        this.store.run(
          "UPDATE user_identities SET lastUsedAt=?,email=? WHERE provider=? AND providerUserId=?",
          now(),
          info.email,
          PROVIDER,
          info.sub,
        );
        return;
      }
      if (
        this.store.get(
          "SELECT id FROM user_identities WHERE userId=? AND provider=?",
          user.id,
          PROVIDER,
        )
      )
        throw new HttpError(
          409,
          "This readm3 account is already linked to a different CoinPay account. Unlink it first.",
        );
      this.insertIdentity(user.id, info);
    })();
  }
  /**
   * The user behind a CoinPay access token presented as an API bearer, if the app
   * it was issued to is trusted. Positive answers are cached by the token's hash
   * until the token expires or for five minutes, whichever is sooner.
   */
  async bearer(token: string): Promise<{ user: User; clientId: string }> {
    const key = checksum(token);
    const stamp = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > stamp)
      return { user: this.store.user(hit.userId), clientId: hit.clientId };
    this.cache.delete(key);
    const info = await this.userinfo(token);
    // Only now is the payload worth reading: CoinPay has vouched for the token.
    const payload = claims(token);
    if (str(payload.sub) !== info.sub)
      throw new HttpError(401, "This CoinPay token does not match its account.");
    const clientId = str(payload.client_id);
    if (!clientId || !this.trusted.has(clientId))
      throw new HttpError(
        403,
        `CoinPay app ${JSON.stringify(clientId ?? "(none)")} is not trusted by this readm3 server. Its operator can add the client_id to READM3_COINPAY_TRUSTED_CLIENTS.`,
        { clientId },
      );
    const user = this.provision(info, "api", clientId);
    const exp = typeof payload.exp === "number" ? payload.exp * 1000 : Infinity;
    const until = Math.min(exp, stamp + CACHE_MS);
    if (this.cache.size > 10000)
      for (const [k, v] of this.cache) if (v.until <= stamp) this.cache.delete(k);
    if (until > stamp) this.cache.set(key, { userId: user.id, clientId, until });
    return { user, clientId };
  }
  private stateCookie(value: string, age = STATE_SECONDS) {
    const secure = this.accounts.origin.startsWith("https:");
    return `${secure ? "__Host-" : ""}readm3_coinpay=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
  }
  private stateFrom(request: Request) {
    const name = `${this.accounts.origin.startsWith("https:") ? "__Host-" : ""}readm3_coinpay=`;
    return (
      request.headers
        .get("cookie")
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(name))
        ?.slice(name.length) ?? ""
    );
  }
  /**
   * /api/v1/coinpay/* — status, the web sign-in redirect pair, the CLI code
   * exchange, and unlink. `user` is whoever the request already authenticates as.
   */
  async route(
    request: Request,
    path: string,
    user: User | null,
    origin: string,
    read: () => Promise<Record<string, unknown>>,
  ): Promise<Response | null> {
    const json = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
      });
    if (path === "coinpay/status" && request.method === "GET")
      return json({
        enabled: this.enabled,
        ...(this.enabled
          ? { clientId: this.clientId, coinpayUrl: this.url, scopes: COINPAY_SCOPES }
          : {}),
        identities: user ? this.identities(user.id) : [],
        // Unlinking an account's only credential would lock it out.
        canUnlink: user
          ? !!this.store.get("SELECT userId FROM account_emails WHERE userId=?", user.id)
          : false,
      });
    if (path === "coinpay/oauth/start" && request.method === "GET") {
      this.require();
      const requested = new URL(request.url).searchParams.get("next");
      const next =
        requested && /^\/(?:admin|viewer|account)(?:\?|$)/.test(requested)
          ? requested
          : null;
      const state = secret();
      const verifier = secret();
      this.store.run("DELETE FROM coinpay_oauth_states WHERE expiresAt<=?", now());
      this.store.run(
        "INSERT INTO coinpay_oauth_states VALUES (?,?,?,?)",
        checksum(state),
        verifier,
        next,
        new Date(Date.now() + STATE_SECONDS * 1000).toISOString(),
      );
      const authorize = `${this.url}/api/oauth/authorize?${new URLSearchParams({
        client_id: this.clientId!,
        redirect_uri: `${origin}/api/v1/coinpay/oauth/callback`,
        response_type: "code",
        scope: COINPAY_SCOPES,
        state,
        code_challenge: pkce(verifier),
        code_challenge_method: "S256",
      })}`;
      return new Response(null, {
        status: 302,
        headers: {
          location: authorize,
          "cache-control": "no-store",
          "set-cookie": this.stateCookie(state),
        },
      });
    }
    if (path === "coinpay/oauth/callback" && request.method === "GET") {
      this.require();
      const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
      headers.append("set-cookie", this.stateCookie("", 0));
      const go = (location: string) => {
        headers.set("location", `${origin}${location}`);
        return new Response(null, { status: 302, headers });
      };
      const fail = (message: string) =>
        go(`/account?coinpay_error=${encodeURIComponent(message)}`);
      const query = new URL(request.url).searchParams;
      const state = query.get("state") ?? "";
      const cookie = this.stateFrom(request);
      if (!state || !cookie || !equalSecret(state, cookie))
        return fail("That CoinPay sign-in could not be matched to this browser. Start again.");
      const pending = this.store.get<{ verifier: string; next: string | null }>(
        "DELETE FROM coinpay_oauth_states WHERE stateHash=? AND expiresAt>? RETURNING verifier,next",
        checksum(state),
        now(),
      );
      if (!pending) return fail("That CoinPay sign-in has expired. Start again.");
      if (query.get("error"))
        return fail(
          query.get("error") === "access_denied"
            ? "CoinPay sign-in was cancelled."
            : `CoinPay sign-in failed: ${query.get("error_description") || query.get("error")}.`.slice(0, 300),
        );
      const code = query.get("code");
      if (!code) return fail("CoinPay sent no authorization code. Start again.");
      try {
        const info = await this.userinfo(
          await this.exchange(code, `${origin}/api/v1/coinpay/oauth/callback`, pending.verifier),
        );
        const current = this.accounts.authenticate(this.accounts.token(request));
        if (current) {
          this.link(current, info);
          return go(pending.next ?? "/account?coinpay=linked");
        }
        const signedIn = this.provision(info, "signin");
        const session = this.accounts.startSession(
          signedIn.id,
          this.accounts.token(request),
          "CoinPay sign-in",
        );
        headers.append("set-cookie", this.accounts.cookie(session));
        return go(pending.next ?? "/account");
      } catch (error) {
        if (error instanceof HttpError) return fail(error.message);
        throw error;
      }
    }
    if (path === "coinpay/oauth/cli-exchange" && request.method === "POST") {
      this.require();
      const args = await read();
      const code = str(args.code);
      const verifier = str(args.code_verifier);
      const redirectUri = str(args.redirect_uri);
      if (!code || !verifier || !redirectUri)
        throw new HttpError(400, "code, code_verifier and redirect_uri are required.");
      if (!LOOPBACK.test(redirectUri))
        throw new HttpError(400, "redirect_uri must be http://127.0.0.1:PORT/callback.");
      const info = await this.userinfo(await this.exchange(code, redirectUri, verifier));
      const signedIn = this.provision(info, "signin");
      const token = this.store.session(signedIn, "api", "CoinPay CLI login");
      return json({ ...token, user: signedIn, identities: this.identities(signedIn.id) }, 201);
    }
    if (path === "coinpay/unlink" && request.method === "POST") {
      if (!user) throw new HttpError(401, "Sign in to unlink CoinPay.");
      const linked = this.store.get<{ providerUserId: string }>(
        "SELECT providerUserId FROM user_identities WHERE userId=? AND provider=?",
        user.id,
        PROVIDER,
      );
      if (!linked) throw new HttpError(404, "No CoinPay account is linked.");
      if (!this.store.get("SELECT userId FROM account_emails WHERE userId=?", user.id))
        throw new HttpError(
          409,
          "This account signs in only with CoinPay. Unlinking it would leave no way to sign in.",
        );
      this.store.db.transaction(() => {
        this.store.run(
          "DELETE FROM user_identities WHERE userId=? AND provider=?",
          user.id,
          PROVIDER,
        );
        this.event(user.id, linked.providerUserId, "unlink");
      })();
      // CoinPay has no revocation endpoint; forgetting cached app tokens is what remains.
      for (const [k, v] of this.cache) if (v.userId === user.id) this.cache.delete(k);
      return json({ ok: true, identities: this.identities(user.id) });
    }
    return null;
  }
}
