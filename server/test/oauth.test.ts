import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../accounts.ts";
import { createApi } from "../api.ts";
import { createOAuth } from "../oauth.ts";
import { createSyncApi } from "../sync-api.ts";
import { Store } from "../store.ts";
import { verifiedAccount } from "./fixtures.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runtime = process.env.READM3_TEST_NODE ? "node" : "bun";
const entry = runtime === "node" ? "bin/readm3.mjs" : "src/cli.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const done of cleanup.splice(0).reverse()) done(); });

async function site() {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  let handlers: ((request: Request) => Promise<Response | null>)[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    for (const handle of handlers) {
      const response = await handle(request);
      if (response) return response;
    }
    return new Response("Not found", { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;
  const accounts = new Accounts(store.db, url, async () => {});
  const api = createApi(store, url);
  handlers = [(r) => accounts.handle(r, "test"), createOAuth(accounts), createSyncApi(store, accounts), (r) => api(r, "test")];
  const { user, token: session } = await verifiedAccount(store, "Ada");
  return { store, url, user, cookie: `readm3_session=${session}` };
}

function cli(url: string, config: string, args: string[]) {
  const env = { ...process.env, READM3_CONFIG_DIR: config, READM3_URL: url, READM3_API_URL: `${url}/api/v1`, READM3_TOKEN: "" };
  return Bun.spawn([Bun.which(runtime)!, entry, ...args], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}
async function run(url: string, config: string, args: string[]) {
  const child = cli(url, config, args);
  child.stdin.end();
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

test("readm3 login over SSH: approve in any browser, paste the code, refresh rotates, logout revokes", async () => {
  const { url, user, cookie } = await site();
  const config = mkdtempSync(join(tmpdir(), "readm3-oauth-cli-"));
  cleanup.push(() => rmSync(config, { recursive: true, force: true }));
  const metadata = await (await fetch(`${url}/.well-known/oauth-authorization-server`)).json();
  expect(metadata).toMatchObject({ issuer: url, code_challenge_methods_supported: ["S256"] });

  const child = cli(url, config, ["login", "--no-browser"]);
  const reader = child.stderr.getReader();
  let printed = "";
  const link = /https?:\/\/\S+\/oauth\/authorize\S+/;
  while (!link.test(printed)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`CLI exited early: ${printed}`);
    printed += new TextDecoder().decode(chunk.value);
  }
  const authorize = new URL(printed.match(link)![0]);
  // The redirect is the server's paste page, never localhost: that is what broke over SSH.
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${url}/oauth/cli`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

  // Signed out: sign in first, then come back to this exact request.
  const signedOut = await fetch(authorize, { redirect: "manual" });
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toBe(`${url}/account?next=${encodeURIComponent(authorize.pathname + authorize.search)}`);

  const consent = await fetch(authorize, { headers: { cookie } });
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("ada@example.com");

  const fields = { ...Object.fromEntries(authorize.searchParams), decision: "approve" };
  const headers = { cookie, origin: url, "content-type": "application/x-www-form-urlencoded" };
  // Another site cannot approve on the person's behalf.
  expect((await fetch(`${url}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { ...headers, origin: "https://evil.example" }, body: form(fields) })).status).toBe(403);
  const approved = await fetch(`${url}/oauth/authorize`, { method: "POST", redirect: "manual", headers, body: form(fields) });
  expect(approved.status).toBe(303);
  const shown = await (await fetch(approved.headers.get("location")!)).text();
  const pasted = shown.match(/<code>([^<]+)<\/code>/)![1]!;
  expect(pasted).toEndWith(`#${authorize.searchParams.get("state")}`);
  child.stdin.write(`${pasted}\n`);
  child.stdin.end();
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(exit, printed).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ signedIn: true, user: { id: user.id } });

  const saved = JSON.parse(readFileSync(join(config, "cloud.json"), "utf8"));
  expect(saved.token).toStartWith("r3_at_");
  expect(saved.oauth.refresh_token).toStartWith("r3_rt_");
  expect((await run(url, config, ["whoami"])).user.id).toBe(user.id);

  // An expired access token is refreshed (and the refresh token rotated) on the next command.
  writeFileSync(join(config, "cloud.json"), JSON.stringify({ ...saved, oauth: { ...saved.oauth, expires_at: 0 } }));
  expect((await run(url, config, ["whoami"])).user.id).toBe(user.id);
  const rotated = JSON.parse(readFileSync(join(config, "cloud.json"), "utf8"));
  expect(rotated.token).not.toBe(saved.token);
  expect(rotated.oauth.refresh_token).not.toBe(saved.oauth.refresh_token);

  // logout revokes the sign-in on the server, not just the local file.
  await run(url, config, ["logout"]);
  const me = await (await fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${rotated.token}` } })).json();
  expect(me.user).toBeNull();
}, 30_000);

test("a reused refresh token ends the whole sign-in", async () => {
  const { url, cookie } = await site();
  const verifier = "v".repeat(64);
  const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
  const params = { response_type: "code", client_id: "readm3-cli", redirect_uri: "http://127.0.0.1:9/callback", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
  const approved = await fetch(`${url}/oauth/authorize`, {
    method: "POST", redirect: "manual",
    headers: { cookie, origin: url, "content-type": "application/x-www-form-urlencoded" },
    body: form({ ...params, decision: "approve" }),
  });
  // Any loopback port is accepted for the native client (RFC 8252).
  const back = new URL(approved.headers.get("location")!);
  expect(back.origin).toBe("http://127.0.0.1:9");
  const token = (body: Record<string, string>) =>
    fetch(`${url}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_id: "readm3-cli", ...body }) });
  const first = await (await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: params.redirect_uri, code_verifier: verifier })).json();
  const second = await (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).json();
  expect(second.access_token).toStartWith("r3_at_");
  const reuse = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
  expect(reuse.status).toBe(400);
  expect((await reuse.json()).error).toBe("invalid_grant");
  const me = await (await fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${second.access_token}` } })).json();
  expect(me.user).toBeNull();
});

test("an unregistered redirect_uri is refused on the page, never redirected to", async () => {
  const { url, cookie } = await site();
  const response = await fetch(`${url}/oauth/authorize?${form({ response_type: "code", client_id: "readm3-cli", redirect_uri: "https://evil.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" })}`, { headers: { cookie }, redirect: "manual" });
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
});
