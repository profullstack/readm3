import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const secret = () => randomBytes(32).toString("base64url");
const id = () => randomBytes(12).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = () => new Date().toISOString();
const SESSION_SECONDS = 30 * 86400;
export type Account = { id: string; username: string; displayName: string; admin: number; createdAt: string; email: string; emailVerifiedAt: string };
export type Mail = { to: string; url: string };
export type SendMail = (mail: Mail) => Promise<void>;
export class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const publicColumns = "u.id,u.username,u.displayName,u.admin,u.createdAt,e.email,e.emailVerifiedAt";

/** Uses the same users/sessions schema as the shared workspace store. */
export class Accounts {
  db: Database;
  cookieName: string;
  constructor(path: string | Database, public origin: string, private sendMail: SendMail) {
    this.origin = new URL(origin).origin;
    this.cookieName = this.origin.startsWith("https:") ? "__Host-readm3_session" : "readm3_session";
    if (typeof path === "string") {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path, { create: true });
    } else this.db = path;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, displayName TEXT NOT NULL, passwordHash TEXT NOT NULL, recoveryHash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tokenHash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE TABLE IF NOT EXISTS account_emails (userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT UNIQUE NOT NULL COLLATE NOCASE, emailVerifiedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_challenges (tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS email_challenges_email ON email_challenges(email);
      CREATE TABLE IF NOT EXISTS account_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    `);
  }
  private rate(key: string, limit: number, seconds: number) {
    const current = Date.now();
    this.db.query("DELETE FROM account_rate_limits WHERE expiresAt<=?").run(current);
    const row = this.db.query(`INSERT INTO account_rate_limits VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).get(hash(key), current + seconds * 1000) as { count: number };
    if (row.count > limit) throw new AccountError(429, "Too many attempts. Please try again later.");
  }
  cookie(token: string, age = SESSION_SECONDS) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  token(request: Request) {
    return request.headers.get("cookie")?.split(";").map(s => s.trim()).find(s => s.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1) ?? "";
  }
  /** Only verified identities are returned. Use this for every workspace API. */
  authenticate(token: string): Account | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.db.query(`SELECT ${publicColumns} FROM sessions s JOIN users u ON u.id=s.userId
      JOIN account_emails e ON e.userId=u.id WHERE s.tokenHash=? AND s.expiresAt>?`).get(hash(token), stamp()) as Account | null;
  }
  requireAccount(request: Request): Account {
    const user = this.authenticate(this.token(request));
    if (!user) throw new AccountError(401, "Sign in with your email to continue.");
    return user;
  }
  private challenge(token: unknown) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccountError(400, "This sign-in link is invalid or has expired. Request a new link.");
    const row = this.db.query("SELECT email FROM email_challenges WHERE tokenHash=? AND expiresAt>?").get(hash(token), stamp()) as { email: string } | null;
    if (!row) throw new AccountError(400, "This sign-in link is invalid or has expired. Request a new link.");
    return row;
  }
  private async requestLink(input: unknown, ip: string, requestedNext?: unknown) {
    const next = typeof requestedNext === "string" && /^\/(?:admin|viewer)(?:\?|$)/.test(requestedNext) ? requestedNext : null;
    this.rate(`send-ip:${ip}`, 20, 3600);
    const email = typeof input === "string" ? input.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) || email.split("@")[0].length > 64) {
      throw new AccountError(400, "Enter a valid email address.");
    }
    this.rate(`send-email-minute:${email}`, 1, 60);
    this.rate(`send-email-hour:${email}`, 5, 3600);
    const token = secret();
    this.db.query("DELETE FROM email_challenges WHERE expiresAt<=?").run(stamp());
    this.db.query("INSERT INTO email_challenges VALUES (?,?,?,?)").run(hash(token), email, new Date(Date.now() + 15 * 60000).toISOString(), stamp());
    try { await this.sendMail({ to: email, url: `${this.origin}/account${next ? "?next=" + encodeURIComponent(next) : ""}#verify=${token}` }); }
    catch {
      this.db.query("DELETE FROM email_challenges WHERE tokenHash=?").run(hash(token));
      throw new AccountError(503, "We couldn't send your sign-in email. Please try again in a minute.");
    }
    return { ok: true, message: "Check your inbox for your sign-in link. It expires in 15 minutes.", retryAfter: 60 };
  }
  private verify(token: unknown, oldToken: string) {
    return this.db.transaction(() => {
      const { email } = this.challenge(token);
      let identity = this.db.query("SELECT userId FROM account_emails WHERE email=?").get(email) as { userId: string } | null;
      if (!identity) {
        const userId = id();
        // No usable password or recovery code: mailbox ownership is the credential.
        this.db.query("INSERT INTO users (id,username,displayName,passwordHash,recoveryHash,admin,createdAt) VALUES (?,?,?,?,?,0,?)")
          .run(userId, `user_${userId.toLowerCase()}`, email.split("@")[0], "!email-login-only", hash(secret()), stamp());
        this.db.query("INSERT INTO account_emails VALUES (?,?,?)").run(userId, email, stamp());
        identity = { userId };
      }
      this.db.query("DELETE FROM email_challenges WHERE email=?").run(email);
      this.db.query("DELETE FROM sessions WHERE tokenHash=? OR expiresAt<=?").run(hash(oldToken), stamp());
      const session = secret();
      this.db.query("INSERT INTO sessions (id,userId,tokenHash,kind,label,expiresAt,createdAt) VALUES (?,?,?,?,?,?,?)")
        .run(id(), identity.userId, hash(session), "browser", "Email sign-in", new Date(Date.now() + SESSION_SECONDS * 1000).toISOString(), stamp());
      return { user: this.authenticate(session)!, session };
    })();
  }
  async handle(request: Request, ip = "unknown"): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/auth/")) return null;
    const reply = (body: unknown, status = 200, cookie?: string) => Response.json(body, { status, headers: {
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      ...(cookie ? { "set-cookie": cookie } : {}),
    } });
    try {
      if (request.method === "GET" && path === "/api/auth/session") return reply({ user: this.authenticate(this.token(request)) });
      if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
      if (request.headers.get("origin") !== this.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AccountError(403, "Please use the account page on this site.");
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new AccountError(415, "Send application/json.");
      const body = await request.text();
      if (body.length > 4096) throw new AccountError(413, "Request too large.");
      let args: Record<string, unknown>;
      try { args = JSON.parse(body); if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(); }
      catch { throw new AccountError(400, "Invalid request."); }
      if (path === "/api/auth/email") return reply(await this.requestLink(args.email, ip, args.next));
      if (path === "/api/auth/preview" || path === "/api/auth/verify") {
        this.rate(`verify:${ip}`, 60, 60);
        if (path.endsWith("preview")) return reply(this.challenge(args.token));
        const result = this.verify(args.token, this.token(request));
        return reply({ user: result.user }, 200, this.cookie(result.session));
      }
      if (path === "/api/auth/logout") {
        this.db.query("DELETE FROM sessions WHERE tokenHash=?").run(hash(this.token(request)));
        return reply({ ok: true }, 200, this.cookie("", 0));
      }
      if (path === "/api/auth/logout-all") {
        const user = this.requireAccount(request);
        this.db.query("DELETE FROM sessions WHERE userId=?").run(user.id);
        return reply({ ok: true }, 200, this.cookie("", 0));
      }
      if (path === "/api/auth/profile") {
        const user = this.requireAccount(request);
        const name = typeof args.displayName === "string" ? args.displayName.trim() : "";
        if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new AccountError(400, "Name must be between 1 and 80 characters.");
        this.db.query("UPDATE users SET displayName=? WHERE id=?").run(name, user.id);
        return reply({ user: this.authenticate(this.token(request)) });
      }
      return reply({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof AccountError) return reply({ error: error.message }, error.status);
      console.error("Account request failed", error instanceof Error ? error.name : "Unknown error");
      return reply({ error: "Something went wrong. Please try again." }, 500);
    }
  }
}
