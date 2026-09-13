import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts, type Mail } from "../accounts.ts";
import { accountMailer } from "../account-mail.ts";

const origin = "https://readm3.com";
const opened: Accounts[] = [];
const directories: string[] = [];
afterEach(() => { for (const app of opened.splice(0)) app.db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(path = ":memory:", fail = false) {
  const mail: Mail[] = [];
  const app = new Accounts(path, origin, async message => { if (fail) throw new Error("Provider failed"); mail.push(message); });
  opened.push(app);
  const request = (action: string, args?: unknown, cookie?: string, source: string | null = origin, ip = "127.0.0.1") => app.handle(new Request(`${origin}/api/auth/${action}`, {
    method: args === undefined ? "GET" : "POST",
    headers: { ...(args === undefined ? {} : { "content-type": "application/json" }), ...(source ? { origin: source } : {}), ...(cookie ? { cookie } : {}) },
    ...(args === undefined ? {} : { body: JSON.stringify(args) }),
  }), ip).then(r => r!);
  const token = () => new URLSearchParams(new URL(mail.at(-1)!.url).hash.slice(1)).get("verify")!;
  const login = async (email = "person@example.com") => {
    expect((await request("email", { email })).status).toBe(200);
    const response = await request("verify", { token: token() });
    return { response, cookie: response.headers.get("set-cookie")!.split(";")[0], user: (await response.json()).user };
  };
  return { app, mail, request, token, login };
}

describe("email-verified accounts", () => {
  test("creates no user or session until mailbox ownership is verified", async () => {
    const { app, mail, request, token } = fixture();
    expect((await request("email", { email: " Person@Example.COM " })).status).toBe(200);
    expect(mail[0].to).toBe("person@example.com");
    expect(mail[0].url.startsWith(`${origin}/account#verify=`)).toBe(true);
    expect(app.db.query("SELECT * FROM users").all()).toHaveLength(0);
    expect(app.db.query("SELECT * FROM sessions").all()).toHaveLength(0);
    expect(await (await request("session")).json()).toEqual({ user: null });
    const preview = await request("preview", { token: token() });
    expect(await preview.json()).toEqual({ email: "person@example.com" });
    expect((await request("verify")).status).toBe(405);
    expect(app.db.query("SELECT * FROM users").all()).toHaveLength(0);
    const verified = await request("verify", { token: token(), admin: 1 });
    expect(verified.status).toBe(200);
    const body = await verified.json();
    expect(body.user.emailVerifiedAt).toBeTruthy();
    expect(body.user.admin).toBe(0);
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.session).toBeUndefined();
    expect(verified.headers.get("set-cookie")).toContain("__Host-readm3_session=");
    expect(verified.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
    expect(verified.headers.get("set-cookie")).toContain("; Secure");
    expect(verified.headers.get("cache-control")).toBe("no-store");
  });
  test("expired and replayed links cannot sign in, including simultaneous requests", async () => {
    const { app, request, token } = fixture();
    await request("email", { email: "person@example.com" });
    const responses = await Promise.all([request("verify", { token: token() }), request("verify", { token: token() })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
    await request("email", { email: "expired@example.com" });
    app.db.query("UPDATE email_challenges SET expiresAt=?").run("2000-01-01T00:00:00.000Z");
    expect((await request("verify", { token: token() })).status).toBe(400);
    expect((await request("verify", { token: "bad" })).status).toBe(400);
    expect(app.db.query("SELECT * FROM users").all()).toHaveLength(1);
  });
  test("returning users keep the same identity and all older email links become invalid", async () => {
    const { app, login, request, token } = fixture();
    const first = await login();
    app.db.query("DELETE FROM account_rate_limits").run();
    await request("email", { email: "PERSON@example.com" });
    const oldLink = token();
    app.db.query("DELETE FROM account_rate_limits").run();
    await request("email", { email: "person@example.com" });
    const response = await request("verify", { token: token() }, first.cookie);
    expect((await response.json()).user.id).toBe(first.user.id);
    expect(await (await request("session", undefined, first.cookie)).json()).toEqual({ user: null });
    expect((await request("verify", { token: oldLink })).status).toBe(400);
    expect(app.db.query("SELECT * FROM users").all()).toHaveLength(1);
  });
  test("sessions persist across database reopening and logout revokes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readm3-accounts-")); directories.push(dir);
    const path = join(dir, "readm3.sqlite");
    const first = fixture(path);
    const { cookie, user } = await first.login();
    opened.splice(opened.indexOf(first.app), 1); first.app.db.close();
    const next = fixture(path);
    expect((await (await next.request("session", undefined, cookie)).json()).user.id).toBe(user.id);
    expect((await next.request("profile", { displayName: "New Name" }, cookie)).status).toBe(200);
    expect((await (await next.request("session", undefined, cookie)).json()).user.displayName).toBe("New Name");
    expect((await next.request("logout", {}, cookie)).headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await next.request("profile", { displayName: "No" }, cookie)).status).toBe(401);
  });
  test("logout-all revokes every device and expired sessions are rejected", async () => {
    const { app, login, request } = fixture();
    const first = await login();
    app.db.query("DELETE FROM account_rate_limits").run();
    const second = await login();
    expect((await request("logout-all", {}, second.cookie)).status).toBe(200);
    for (const cookie of [first.cookie, second.cookie]) expect(await (await request("session", undefined, cookie)).json()).toEqual({ user: null });
    app.db.query("DELETE FROM account_rate_limits").run();
    const third = await login();
    app.db.query("UPDATE sessions SET expiresAt=?").run("2000-01-01T00:00:00.000Z");
    expect(await (await request("session", undefined, third.cookie)).json()).toEqual({ user: null });
  });
  test("legacy sessions without a verified email cannot access an account", async () => {
    const { app, login, request } = fixture();
    const { cookie } = await login();
    app.db.query("DELETE FROM account_emails").run();
    expect(await (await request("session", undefined, cookie)).json()).toEqual({ user: null });
    expect(() => app.requireAccount(new Request(origin, { headers: { cookie } }))).toThrow("Sign in");
  });
  test("cross-origin writes and missing origins cannot send mail, verify, edit, or log out", async () => {
    const { mail, request, login } = fixture();
    const { cookie } = await login();
    for (const source of [null, "https://evil.example", "https://sub.readm3.com"]) {
      for (const action of ["email", "verify", "profile", "logout", "logout-all"]) expect((await request(action, {}, cookie, source)).status).toBe(403);
    }
    expect(mail).toHaveLength(1);
    expect((await (await request("session", undefined, cookie)).json()).user).toBeTruthy();
  });
  test("delivery failures remove tokens and never pretend the message was sent", async () => {
    const { app, request } = fixture(":memory:", true);
    const response = await request("email", { email: "person@example.com" });
    expect(response.status).toBe(503);
    expect(app.db.query("SELECT * FROM email_challenges").all()).toHaveLength(0);
    expect(app.db.query("SELECT * FROM users").all()).toHaveLength(0);
    await expect(accountMailer("", "")({ to: "person@example.com", url: origin })).rejects.toThrow("not configured");
  });
  test("rate limits persist across instances and cannot be avoided by email casing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readm3-limits-")); directories.push(dir);
    const path = join(dir, "accounts.sqlite");
    const first = fixture(path);
    await first.request("email", { email: "person@example.com" });
    const next = fixture(path);
    expect((await next.request("email", { email: "PERSON@EXAMPLE.COM" }, undefined, origin, "another-ip")).status).toBe(429);
    expect(next.mail).toHaveLength(0);
    for (let i = 0; i < 20; i++) expect((await next.request("email", { email: `user${i}@example.com` }, undefined, origin, "limited-ip")).status).toBe(200);
    expect((await next.request("email", { email: "last@example.com" }, undefined, origin, "limited-ip")).status).toBe(429);
  });
  test("only hashes of challenges, sessions, and rate limit keys are stored", async () => {
    const { app, request, token, mail } = fixture();
    await request("email", { email: "person@example.com" });
    const challenge = JSON.stringify(app.db.query("SELECT * FROM email_challenges").all());
    expect(challenge).not.toContain(token());
    const verified = await request("verify", { token: token() });
    const cookie = verified.headers.get("set-cookie")!;
    const raw = cookie.split(";")[0].split("=")[1];
    expect(JSON.stringify(app.db.query("SELECT * FROM sessions").all())).not.toContain(raw);
    expect(JSON.stringify(app.db.query("SELECT * FROM account_rate_limits").all())).not.toContain(mail[0].to);
    expect(app.db.query("SELECT tokenHash FROM sessions").get()).toEqual({ tokenHash: createHash("sha256").update(raw).digest("hex") });
  });
  test("rejects invalid input, oversize bodies, unsupported content types, and profile escalation", async () => {
    const { request, app, login } = fixture();
    for (const email of ["", "bad", "a@localhost", "a@bad..com", "a\n@example.com", "x".repeat(65) + "@example.com"]) expect((await request("email", { email })).status).toBe(400);
    expect((await request("email", { email: "x".repeat(5000) })).status).toBe(413);
    expect((await request("email", [] )).status).toBe(400);
    const wrongType = await app.handle(new Request(`${origin}/api/auth/email`, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}" }));
    expect(wrongType!.status).toBe(415);
    const { cookie } = await login();
    const changed = await request("profile", { displayName: "Test", admin: 1, email: "imposter@example.com" }, cookie);
    const user = (await changed.json()).user;
    expect(user.admin).toBe(0); expect(user.email).toBe("person@example.com");
  });
});
