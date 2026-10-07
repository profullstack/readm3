import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../accounts.ts";
import { createApi } from "../api.ts";
import { CoinPay, type CoinPayOptions } from "../coinpay.ts";
import { Store, id } from "../store.ts";
import { verifiedAccount } from "./fixtures.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runtime = process.env.READM3_TEST_NODE ? "node" : "bun";
const entry = runtime === "node" ? "bin/readm3.mjs" : "src/cli.ts";
const origin = "http://localhost";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });

type Person = { sub: string; name?: string; email?: string };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** CoinPay's token and userinfo endpoints, enough to issue codes and HS256-shaped access tokens. */
function fakeCoinPay() {
  const codes = new Map<string, { person: Person; challenge: string; redirectUri: string }>();
  const tokens = new Map<string, Person>();
  const calls = { token: 0, userinfo: 0 };
  const issue = (person: Person, clientId = "readm3-test", ttl = 3600) => {
    const token = [b64({ alg: "HS256", typ: "JWT" }), b64({ sub: person.sub, client_id: clientId, scope: "openid profile email", iss: "https://coinpayportal.com", exp: Math.floor(Date.now() / 1000) + ttl }), id()].join(".");
    tokens.set(token, person);
    return token;
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/oauth/token" && request.method === "POST") {
      calls.token++;
      const form = new URLSearchParams(await request.text());
      if (form.get("client_id") !== "readm3-test" || form.get("client_secret") !== "test-secret") return Response.json({ error: "invalid_client" }, { status: 401 });
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!grant || grant.challenge !== verifier || grant.redirectUri !== form.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: issue(grant.person), token_type: "Bearer", expires_in: 3600, refresh_token: id(), scope: "openid profile email" });
    }
    if (url.pathname === "/api/oauth/userinfo") {
      calls.userinfo++;
      const person = tokens.get(request.headers.get("authorization")?.slice(7) ?? "");
      if (!person) return Response.json({ error: "invalid_token" }, { status: 401 });
      return Response.json({ sub: person.sub, name: person.name ?? null, email: person.email ?? null, email_verified: false, wallets: [], did: null });
    }
    return new Response("Not found", { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  /** What CoinPay's authorize page does once the person approves. */
  const grant = (person: Person, authorize: string) => {
    const params = new URL(authorize).searchParams;
    const code = id();
    codes.set(code, { person, challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")! });
    return { code, state: params.get("state")!, redirectUri: params.get("redirect_uri")! };
  };
  return { url: `http://127.0.0.1:${server.port}`, calls, issue, grant };
}

function fixture(options: Partial<CoinPayOptions> = {}) {
  const coinpay = fakeCoinPay();
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const accounts = new Accounts(store.db, origin, async () => {});
  const api = createApi(store, origin, new CoinPay(store, accounts, { clientId: "readm3-test", clientSecret: "test-secret", url: coinpay.url, trustedClients: ["ai-profullstack"], ...options }));
  const ip = id();
  const call = async (route: string, init: { method?: string; data?: unknown; bearer?: string; cookie?: string; origin?: string } = {}) => {
    const response = (await api(new Request(`${origin}/api/v1/${route}`, {
      method: init.method ?? (init.data === undefined ? "GET" : "POST"),
      headers: {
        ...(init.data === undefined ? {} : { "content-type": "application/json", origin: init.origin ?? origin }),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.cookie ? { cookie: init.cookie } : {}),
      },
      body: init.data === undefined ? undefined : JSON.stringify(init.data),
    }), ip))!;
    const text = await response.text();
    return { status: response.status, response, data: text ? JSON.parse(text) : null };
  };
  /** The whole browser round trip: start, CoinPay approves, callback. Returns the session cookie it ends with. */
  const web = async (person: Person, session = "") => {
    const start = await call("coinpay/oauth/start?next=%2Fadmin", { cookie: session || undefined });
    expect(start.status).toBe(302);
    const stateCookie = start.response.headers.getSetCookie()[0]!.split(";")[0]!;
    expect(start.response.headers.getSetCookie()[0]).toContain("HttpOnly; SameSite=Lax");
    const approved = coinpay.grant(person, start.response.headers.get("location")!);
    expect(approved.redirectUri).toBe(`${origin}/api/v1/coinpay/oauth/callback`);
    const back = await call(`coinpay/oauth/callback?code=${approved.code}&state=${approved.state}`, { cookie: [stateCookie, session].filter(Boolean).join("; ") });
    expect(back.status).toBe(302);
    const location = new URL(back.response.headers.get("location")!);
    const sessionCookie = back.response.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("readm3_session="));
    return { location, cookie: sessionCookie ?? session };
  };
  const me = async (cookie: string) => (await call("me", { cookie })).data.user;
  return { coinpay, store, call, web, me };
}

test("CoinPay sign-in creates a user with a personal workspace and a browser session, and the next sign-in reuses it", async () => {
  const f = fixture();
  const first = await f.web({ sub: "cp_alice", name: "Alice", email: "alice@example.com" });
  expect(first.location.pathname).toBe("/admin");
  const alice = await f.me(first.cookie);
  expect(alice.displayName).toBe("Alice");
  // CoinPay's email is unverified: it is kept on the identity, never as an account email.
  expect(f.store.all("SELECT * FROM account_emails")).toHaveLength(0);
  expect(f.store.get<{ email: string }>("SELECT email FROM user_identities WHERE providerUserId='cp_alice'")!.email).toBe("alice@example.com");
  const orgs = (await f.call("actions", { data: { operation: "organizations_list" }, cookie: first.cookie })).data;
  expect(orgs).toHaveLength(1);
  expect(f.store.get<{ kind: string; label: string }>("SELECT kind,label FROM sessions")).toEqual({ kind: "browser", label: "CoinPay sign-in" });
  const second = await f.web({ sub: "cp_alice", name: "Alice", email: "alice@example.com" });
  expect((await f.me(second.cookie)).id).toBe(alice.id);
  expect(f.store.all("SELECT id FROM users")).toHaveLength(1);
  expect(f.store.all<{ event: string }>("SELECT event FROM identity_events ORDER BY rowid").map((e) => e.event)).toEqual(["link", "signin", "signin"]);
  const whoami = (await f.call("actions", { data: { operation: "account_me" }, cookie: second.cookie })).data;
  expect(whoami.identities).toMatchObject([{ provider: "coinpay", providerUserId: "cp_alice" }]);
});

test("a signed-in user links CoinPay; an identity owned by someone else is refused; an email match never merges", async () => {
  const f = fixture();
  const owner = await verifiedAccount(f.store, "owner");
  const ownerCookie = `readm3_session=${owner.token}`;
  const linked = await f.web({ sub: "cp_owner", email: "owner@example.com" }, ownerCookie);
  expect(linked.location.pathname).toBe("/admin");
  expect(f.store.get<{ userId: string }>("SELECT userId FROM user_identities WHERE providerUserId='cp_owner'")!.userId).toBe(owner.user.id);
  // Signing in with that CoinPay account later lands on the email account.
  expect((await f.me((await f.web({ sub: "cp_owner" })).cookie)).id).toBe(owner.user.id);

  const other = await verifiedAccount(f.store, "other");
  const refused = await f.web({ sub: "cp_owner" }, `readm3_session=${other.token}`);
  expect(refused.location.pathname).toBe("/account");
  expect(refused.location.searchParams.get("coinpay_error")).toContain("already linked to a different readm3 account");
  expect(f.store.all("SELECT * FROM user_identities WHERE userId=?", other.user.id)).toHaveLength(0);

  // Same address as an existing verified account, different CoinPay account: a new user.
  const stranger = await f.web({ sub: "cp_stranger", email: "other@example.com" });
  const strangerUser = await f.me(stranger.cookie);
  expect(strangerUser.id).not.toBe(other.user.id);
  expect(f.store.all("SELECT * FROM account_emails WHERE userId=?", strangerUser.id)).toHaveLength(0);
});

test("callbacks without this browser's state, or with an expired state, are refused", async () => {
  const f = fixture();
  const start = await f.call("coinpay/oauth/start");
  const approved = f.coinpay.grant({ sub: "cp_x" }, start.response.headers.get("location")!);
  const forged = await f.call(`coinpay/oauth/callback?code=${approved.code}&state=${approved.state}`);
  expect(new URL(forged.response.headers.get("location")!).searchParams.get("coinpay_error")).toContain("could not be matched");
  const cookie = start.response.headers.getSetCookie()[0]!.split(";")[0]!;
  f.store.run("UPDATE coinpay_oauth_states SET expiresAt='2000-01-01T00:00:00.000Z'");
  const late = await f.call(`coinpay/oauth/callback?code=${approved.code}&state=${approved.state}`, { cookie });
  expect(new URL(late.response.headers.get("location")!).searchParams.get("coinpay_error")).toContain("expired");
  expect(f.store.all("SELECT * FROM users")).toHaveLength(0);
});

test("unlink needs another way in, and an unconfigured server hides CoinPay and answers 503", async () => {
  const f = fixture();
  const only = await f.web({ sub: "cp_only" });
  expect((await f.call("coinpay/status", { cookie: only.cookie })).data).toMatchObject({ enabled: true, clientId: "readm3-test", canUnlink: false });
  expect((await f.call("coinpay/unlink", { data: {}, cookie: only.cookie })).status).toBe(409);
  const owner = await verifiedAccount(f.store, "unlinker");
  const cookie = `readm3_session=${owner.token}`;
  await f.web({ sub: "cp_unlinker" }, cookie);
  const unlinked = await f.call("coinpay/unlink", { data: {}, cookie });
  expect(unlinked.status).toBe(200);
  expect(unlinked.data.identities).toEqual([]);
  expect(f.store.all<{ event: string }>("SELECT event FROM identity_events WHERE userId=? ORDER BY rowid", owner.user.id).map((e) => e.event)).toEqual(["link", "unlink"]);

  const off = fixture({ clientId: undefined });
  expect((await off.call("coinpay/status")).data.enabled).toBe(false);
  expect((await off.call("coinpay/oauth/start")).status).toBe(503);
  expect((await off.call("coinpay/oauth/cli-exchange", { data: {} })).status).toBe(503);
});

test("a trusted app's CoinPay token creates a document without orgId and gets a share link; userinfo is cached", async () => {
  const f = fixture();
  const token = f.coinpay.issue({ sub: "cp_app_user", name: "App User" }, "ai-profullstack");
  const created = await f.call("documents", { data: { title: "Answer.md", source: "# An answer", access: "private" }, bearer: token });
  expect(created.status).toBe(201);
  const userId = f.store.get<{ userId: string }>("SELECT userId FROM user_identities WHERE providerUserId='cp_app_user'")!.userId;
  expect(created.data.ownerId).toBe(userId);
  expect(created.data.orgId).toBe(f.store.get<{ orgId: string }>("SELECT orgId FROM members WHERE userId=?", userId)!.orgId);
  const share = await f.call(`documents/${created.data.id}/shares`, { data: { role: "view" }, bearer: token });
  expect(share.status).toBe(200);
  expect(share.data.url).toMatch(/^http:\/\/localhost\/s\/[\w-]{43}$/);
  const shared = await f.call(`shared/${share.data.url.split("/s/")[1]}`);
  expect(shared.data.version.source).toBe("# An answer");
  expect(shared.data.canEdit).toBe(false);
  // Two API calls, one userinfo lookup; the acting app is on the audit trail.
  expect(f.coinpay.calls.userinfo).toBe(1);
  expect(f.store.all("SELECT clientId FROM identity_events WHERE event='api'")).toEqual([{ clientId: "ai-profullstack" }]);
  // The same person signing in on the web lands on the account the app made.
  expect((await f.me((await f.web({ sub: "cp_app_user" })).cookie)).id).toBe(userId);
});

test("CoinPay tokens from untrusted apps are refused by client_id, and invalid ones are 401", async () => {
  const f = fixture();
  const untrusted = await f.call("documents", { data: { title: "x.md", source: "x" }, bearer: f.coinpay.issue({ sub: "cp_u" }, "some-other-app") });
  expect(untrusted.status).toBe(403);
  expect(untrusted.data.error).toContain('"some-other-app"');
  expect(untrusted.data.clientId).toBe("some-other-app");
  expect(f.store.all("SELECT * FROM users")).toHaveLength(0);
  const forged = [b64({ alg: "HS256" }), b64({ sub: "cp_u", client_id: "ai-profullstack" }), "bad"].join(".");
  expect((await f.call("documents", { data: { title: "x.md", source: "x" }, bearer: forged })).status).toBe(401);
  // A foreign browser Origin is still refused before any token is considered.
  const before = f.coinpay.calls.userinfo;
  const cross = await f.call("documents", { data: { title: "x.md", source: "x" }, bearer: f.coinpay.issue({ sub: "cp_u" }, "ai-profullstack"), origin: "https://evil.example" });
  expect(cross.status).toBe(403);
  expect(f.coinpay.calls.userinfo).toBe(before);
});

test("the CLI exchange turns a loopback CoinPay grant into a readm3 API token", async () => {
  const f = fixture();
  const verifier = id() + id();
  const redirectUri = "http://127.0.0.1:49152/callback";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = `${f.coinpay.url}/api/oauth/authorize?code_challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}&state=s`;
  const { code } = f.coinpay.grant({ sub: "cp_cli", name: "CLI" }, authorize);
  expect((await f.call("coinpay/oauth/cli-exchange", { data: { code, code_verifier: verifier, redirect_uri: "https://evil.example/callback" } })).status).toBe(400);
  const exchanged = await f.call("coinpay/oauth/cli-exchange", { data: { code, code_verifier: verifier, redirect_uri: redirectUri } });
  expect(exchanged.status).toBe(201);
  expect(exchanged.data.token).toMatch(/^[\w-]{43}$/);
  expect(exchanged.data.identities).toMatchObject([{ providerUserId: "cp_cli" }]);
  expect((await f.call("me", { bearer: exchanged.data.token })).data.user.displayName).toBe("CLI");
  // Codes are single use.
  expect((await f.call("coinpay/oauth/cli-exchange", { data: { code, code_verifier: verifier, redirect_uri: redirectUri } })).status).toBe(400);
});

test("readm3 login --coinpay runs the loopback grant and saves a token whoami can use", async () => {
  const coinpay = fakeCoinPay();
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  let api: ReturnType<typeof createApi> | undefined;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    return (await api!(request, "cli-test")) || new Response("Not found", { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;
  const accounts = new Accounts(store.db, url, async () => {});
  api = createApi(store, url, new CoinPay(store, accounts, { clientId: "readm3-test", clientSecret: "test-secret", url: coinpay.url }));
  const config = mkdtempSync(join(tmpdir(), "readm3-coinpay-cli-"));
  cleanup.push(() => rmSync(config, { recursive: true, force: true }));
  const env = { ...process.env, READM3_CONFIG_DIR: config, READM3_URL: url, READM3_API_URL: `${url}/api/v1`, READM3_TOKEN: "", READM3_NO_BROWSER: "1" };
  const child = Bun.spawn([Bun.which(runtime)!, entry, "login", "--coinpay"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  // Read stderr until the authorize link appears, then play CoinPay and the browser.
  const reader = child.stderr.getReader();
  let printed = "";
  while (!/https?:\/\/\S+\/api\/oauth\/authorize\S+/.test(printed)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`CLI exited early: ${printed}`);
    printed += new TextDecoder().decode(chunk.value);
  }
  const authorize = printed.match(/https?:\/\/\S+\/api\/oauth\/authorize\S+/)![0];
  expect(new URL(authorize).searchParams.get("code_challenge_method")).toBe("S256");
  const approved = coinpay.grant({ sub: "cp_terminal", name: "Terminal" }, authorize);
  expect(approved.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const landed = await fetch(`${approved.redirectUri}?code=${approved.code}&state=${approved.state}`);
  expect(landed.status).toBe(200);
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit).toBe(0);
  expect(JSON.parse(stdout).user.displayName).toBe("Terminal");
  expect(JSON.parse(readFileSync(join(config, "cloud.json"), "utf8")).token).toMatch(/^[\w-]{43}$/);
  const whoami = Bun.spawn([Bun.which(runtime)!, entry, "whoami"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(whoami.stdout).text(), new Response(whoami.stderr).text(), whoami.exited]);
  expect(code, err).toBe(0);
  expect(JSON.parse(out).identities).toMatchObject([{ provider: "coinpay", providerUserId: "cp_terminal" }]);
}, 20_000);
