import { afterEach, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, digestFiles, type SyncContext } from "@profullstack/synconfig";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store, checksum, now } from "../store.ts";
import { createApi } from "../api.ts";
import { createSyncApi } from "../sync-api.ts";
import { loadSettings, saveSettings, syncContext } from "../../src/settings-sync.ts";
import { SYNC_POLICY } from "../../src/sync-schema.ts";
import { writeConfig } from "../../src/account.ts";
import { digestFiles as browserDigest } from "../../site/sync.ts";

import { Accounts } from "../accounts.ts";
import { verifiedAccount } from "./fixtures.ts";
import { fileURLToPath } from "node:url";
const repository = fileURLToPath(new URL("../..", import.meta.url));
const runtime = process.env.READM3_TEST_NODE ? "node" : "bun";
const entry = runtime === "node" ? "bin/readm3.mjs" : "src/cli.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "readm3-sync-"));
  const store = new Store(join(root, "test.sqlite"));
  const api = createApi(store);
  const accounts = new Accounts(store.db, "http://localhost", async () => {});
  const sync = createSyncApi(store, accounts);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => await sync(request) || await api(request) || new Response("Missing", { status: 404 }) });
  cleanup.push(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
  const alice = await verifiedAccount(store, "sync_alice");
  const bob = await verifiedAccount(store, "sync_bob");
  const base = `http://127.0.0.1:${server.port}/api/v1`;
  accounts.origin = new URL(base).origin;
  async function call(path: string, token = alice.token, method = "GET", body?: unknown) {
    return fetch(`${base}/${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  function context(name: string, token = alice.token): SyncContext {
    return { rootDir: join(root, name), policy: SYNC_POLICY, api: base, host: name, app: "readm3 test", client: createClient({ baseUrl: base, path: "/settings", token }) };
  }
  return { root, store, accounts, base, call, context, alice, bob };
}
const snapshot = (theme = "nord") => ({ version: 1 as const, host: "test", app: "test", files: { "settings.json": { content: JSON.stringify({ theme }) } } });

test("sync requires an account, isolates users and rejects stale and simultaneous saves", async () => {
  const f = await fixture();
  expect((await f.call("settings", "invalid")).status).toBe(401);
  expect((await f.call("settings")).status).toBe(404);
  const results = await Promise.all(["nord", "light"].map((theme) => f.call("settings", f.alice.token, "PUT", { snapshot: snapshot(theme), ifRevision: 0 })));
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const current = await (await f.call("settings")).json();
  expect(current.revision).toBe(1);
  expect(current.digest).toBe(digestFiles(current.snapshot.files));
  expect(current.userId).toBe(f.alice.user.id);
  expect((await f.call("settings", f.bob.token)).status).toBe(404);
  expect((await f.call(`settings?accountId=${f.alice.user.id}`, f.bob.token)).status).toBe(409);
  expect((await f.call("settings", f.bob.token, "PUT", { accountId: f.alice.user.id, snapshot: snapshot(), ifRevision: null })).status).toBe(409);
  expect((await f.call("settings", f.alice.token, "PUT", { snapshot: snapshot("dark"), ifRevision: 0 })).status).toBe(409);
  const unchanged = await (await f.call("settings", f.alice.token, "PUT", { snapshot: current.snapshot, ifRevision: 1 })).json();
  expect(unchanged.unchanged).toBe(true);
  expect(unchanged.revision).toBe(1);
});

test("sync rejects credentials, malformed workspace paths, invalid revisions and cross-origin writes", async () => {
  const f = await fixture();
  for (const files of [
    { "cloud.json": { content: '{"token":"secret"}' } },
    { "settings.json": { content: '{"token":"secret"}' } },
    { "../settings.json": { content: "{}" } },
    { "workspace.json": { content: JSON.stringify({ name: "notes", active: "../secret.md", documents: [{ path: "../secret.md", source: "x" }] }) } },
  ]) expect((await f.call("settings", f.alice.token, "PUT", { snapshot: { ...snapshot(), files }, ifRevision: 0 })).status).toBe(400);
  for (const ifRevision of [undefined, "0", -1, 1.5]) expect((await f.call("settings", f.alice.token, "PUT", { snapshot: snapshot(), ifRevision })).status).toBe(428);
  const response = await fetch(`${f.base}/settings`, { method: "PUT", headers: { authorization: `Bearer ${f.alice.token}`, origin: "https://unrelated.example", "content-type": "application/json" }, body: JSON.stringify({ snapshot: snapshot(), ifRevision: 0 }) });
  expect(response.status).toBe(403);
  const cookieRequest = (origin?: string) => fetch(`${f.base}/settings`, { method: "PUT", headers: { cookie: `readm3_session=${f.alice.token}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ snapshot: snapshot(), ifRevision: 0 }) });
  expect((await cookieRequest()).status).toBe(403);
  expect((await cookieRequest(new URL(f.base).origin)).status).toBe(200);
  f.store.run("UPDATE sessions SET expiresAt=? WHERE tokenHash=?", "2000-01-01T00:00:00.000Z", checksum(f.alice.token));
  expect((await f.call("settings")).status).toBe(401);
});

test("sync rejects unverified identities and uses the secure production cookie", async () => {
  const f = await fixture();
  f.store.run("INSERT INTO users VALUES (?,?,?,?,?,?,?)", "unverified", "unverified", "Unverified", "unused", "unused", 0, now());
  const unverified = f.store.session(f.store.user("unverified"), "api");
  expect((await f.call("settings", unverified.token)).status).toBe(401);
  expect((await f.call("settings", unverified.token, "PUT", { snapshot: snapshot(), ifRevision: 0 })).status).toBe(401);
  for (const action of ["register", "login", "recover"]) expect((await f.call(`auth/${action}`, unverified.token, "POST", {})).status).toBe(410);
  const accounts = new Accounts(f.store.db, "https://readm3.example", async () => {});
  const sync = createSyncApi(f.store, accounts);
  const request = (cookie: string) => sync(new Request("https://readm3.example/api/v1/settings", { method: "PUT", headers: { origin: accounts.origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ snapshot: snapshot(), ifRevision: 0 }) }));
  expect((await request(`readm3_session=${f.alice.token}`))!.status).toBe(401);
  expect((await request(`__Host-readm3_session=${f.alice.token}`))!.status).toBe(200);
});

test("revisions are durable, monotonic and retain only the last ten saves", async () => {
  const f = await fixture();
  for (let revision = 0; revision < 12; revision++) {
    const saved = await (await f.call("settings", f.alice.token, "PUT", { snapshot: snapshot(`theme-${revision}`), ifRevision: revision })).json();
    expect(saved.revision).toBe(revision + 1);
  }
  const revisions = await (await f.call("settings/revisions")).json();
  expect(revisions.revisions.map((r: { revision: number }) => r.revision)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  const other = new Store(join(f.root, "test.sqlite"));
  try {
    const response = await createSyncApi(other, new Accounts(other.db, new URL(f.base).origin, async () => {}))(new Request(`${f.base}/settings`, { headers: { authorization: `Bearer ${f.alice.token}` } }));
    expect((await response!.json()).revision).toBe(12);
  } finally { other.close(); }
});

test("CLI sync protects first saves and first loads, detects drift and backs up forced loads", async () => {
  const f = await fixture();
  const a = f.context("device-a");
  const b = f.context("device-b");
  writeConfig("settings.json", { theme: "nord" }, a.rootDir);
  writeConfig("cloud.json", { token: "must stay local" }, a.rootDir);
  expect((await saveSettings(a)).status).toBe("saved");
  writeConfig("settings.json", { theme: "light" }, b.rootDir);
  expect((await saveSettings(b)).status).toBe("conflict");
  expect((await loadSettings(b)).status).toBe("local_changes");
  const loaded = await loadSettings(b, { force: true });
  expect(loaded.status).toBe("loaded");
  expect(JSON.parse(readFileSync(join(b.rootDir, "settings.bak-001.json"), "utf8"))).toEqual({ theme: "light" });
  writeConfig("settings.json", { theme: "dark" }, b.rootDir);
  writeConfig("settings.json", { theme: "light" }, a.rootDir);
  expect((await saveSettings(a)).status).toBe("saved");
  expect((await loadSettings(b)).status).toBe("local_changes");
  expect((await loadSettings(b, { dryRun: true })).status).toBe("planned");
  expect((await loadSettings(b, { force: true })).status).toBe("loaded");
  expect(JSON.parse(readFileSync(join(b.rootDir, "settings.bak-002.json"), "utf8"))).toEqual({ theme: "dark" });
  const latest = await a.client.get();
  expect(Object.keys(latest!.snapshot.files)).toEqual(["settings.json"]);
});

test("local sync refuses symlinks and uses different markers for different accounts", async () => {
  const f = await fixture();
  const root = join(f.root, "client");
  writeConfig("cloud.json", { url: new URL(f.base).origin, token: f.alice.token }, root);
  const a = await syncContext(root);
  writeConfig("cloud.json", { url: new URL(f.base).origin, token: f.bob.token }, root);
  const b = await syncContext(root);
  expect(a.markerName).not.toBe(b.markerName);
  writeFileSync(join(f.root, "secret"), '{"theme":"nord"}');
  symlinkSync(join(f.root, "secret"), join(root, "settings.json"));
  await expect(saveSettings(b)).rejects.toThrow("regular file");
});

test("browser digests match synconfig for Unicode and file ordering", async () => {
  const files = { "workspace.json": { content: '😺\u0000é\n' }, "settings.json": { content: "{}" } };
  expect(await browserDigest(files)).toBe(digestFiles(files));
});

test("real CLI token login, workspace save/load and logout use the verified account", async () => {
  const f = await fixture();
  const first = join(f.root, "cli-first");
  const second = join(f.root, "cli-second");
  const run = async (root: string, args: string[], input = "") => {
    const child = Bun.spawn([Bun.which(runtime)!, entry, ...args], { cwd: repository, env: { ...process.env, READM3_CONFIG_DIR: root, READM3_URL: new URL(f.base).origin, READM3_API_URL: f.base, READM3_TOKEN: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(input); child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`CLI failed: ${stderr || stdout}`);
    return JSON.parse(stdout);
  };
  const created = await run(first, ["login", "--token-stdin"], f.alice.token + "\n");
  expect(created.user.id).toBe(f.alice.user.id);
  if (process.platform !== "win32") expect(statSync(join(first, "cloud.json")).mode & 0o777).toBe(0o600);
  await run(first, ["settings", "--theme", "nord", "--flavor", "reddit"]);
  const markdown = join(f.root, "notes.md");
  writeFileSync(markdown, "# A CLI workspace 😺\n");
  expect((await run(first, ["save", markdown])).status).toBe("saved");
  const login = await run(second, ["login", "--token-stdin"], f.alice.token + "\n");
  expect(login.user.id).toBe(created.user.id);
  const output = join(f.root, "exported");
  const loaded = await run(second, ["load", output]);
  expect(loaded.status).toBe("loaded");
  expect(readFileSync(join(output, "notes.md"), "utf8")).toBe("# A CLI workspace 😺\n");
  expect(JSON.parse(readFileSync(join(second, "settings.json"), "utf8"))).toEqual({ theme: "nord", flavor: "reddit" });
  const token = JSON.parse(readFileSync(join(second, "cloud.json"), "utf8")).token;
  await run(second, ["logout"]);
  expect(existsSync(join(second, "cloud.json"))).toBe(false);
  expect((await f.call("settings", token)).status).toBe(200); // Logout forgets the local token; /admin revokes remote copies.
}, 20_000);

test("MCP uses the same account and sync API over its real stdio transport", async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({ command: Bun.which(runtime)!, args: [entry, "mcp"], cwd: repository, env: { ...process.env, READM3_URL: new URL(f.base).origin, READM3_TOKEN: f.alice.token, READM3_CONFIG_DIR: join(f.root, "mcp") } as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(transport);
  const listed = await client.listTools();
  expect(listed.tools.some((tool) => tool.name === "settings_save")).toBe(true);
  const saved = await client.callTool({ name: "settings_save", arguments: { snapshot: snapshot(), ifRevision: 0 } });
  expect(saved.isError).not.toBe(true);
  const loaded = await client.callTool({ name: "settings_get", arguments: {} });
  const value = JSON.parse((loaded.content as { text: string }[])[0].text);
  expect(value.revision).toBe(1);
  expect(value.userId).toBe(f.alice.user.id);
  const stale = await client.callTool({ name: "settings_save", arguments: { snapshot: snapshot("light"), ifRevision: 0 } });
  expect(stale.isError).toBe(true);
  f.store.run("DELETE FROM sessions WHERE tokenHash=?", checksum(f.alice.token));
  expect((await client.callTool({ name: "settings_get", arguments: {} })).isError).toBe(true);
}, 20_000);
