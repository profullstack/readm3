import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { Accounts } from "../accounts.ts";
import { FileHistory, KEEP_VERSIONS, createFileHistoryApi } from "../file-history.ts";
import { deriveKey, newKdf, open, pathTag, seal } from "../../src/sync-crypto.ts";
import { verifiedAccount } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "readm3-file-history-"));
  const store = new Store(join(root, "test.sqlite"));
  const accounts = new Accounts(store.db, "http://localhost", async () => {});
  const api = createFileHistoryApi(new FileHistory(store), accounts);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => await api(request) || new Response("Missing", { status: 404 }) });
  cleanup.push(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
  const alice = await verifiedAccount(store, "history_alice");
  const bob = await verifiedAccount(store, "history_bob");
  const base = `http://127.0.0.1:${server.port}/api/v1/file-history`;
  accounts.origin = new URL(base).origin;
  const call = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { alice, bob, call };
}

test("versions are filed per encrypted path, newest first, and only the owner reads them", async () => {
  const f = await fixture();
  const key = await deriveKey("correct horse battery", { ...newKdf(), iterations: 100_000 });
  const tag = await pathTag("notes/plan.md", key);
  const version = async (source: string) => JSON.stringify(await seal({ path: "notes/plan.md", source, device: "desktop" }, key));

  expect((await f.call(`?tag=${tag}`, "nope")).status).toBe(401);
  expect((await f.call("", f.alice.token, { versions: [{ tag, sealed: "not json" }] })).status).toBe(400);
  expect((await f.call("", f.alice.token, { versions: [{ tag: "notes/plan.md", sealed: await version("x") }] })).status).toBe(400);

  // The text before the first synced edit is filed only while the file has no history.
  expect((await f.call("", f.alice.token, { versions: [{ tag, sealed: await version("one"), ifEmpty: true }, { tag, sealed: await version("two") }] })).body).toEqual({ saved: 2 });
  expect((await f.call("", f.alice.token, { versions: [{ tag, sealed: await version("stale"), ifEmpty: true }, { tag, sealed: await version("three") }] })).body).toEqual({ saved: 1 });

  const listed = (await f.call(`?tag=${tag}`, f.alice.token)).body.versions as { id: string }[];
  expect(listed.length).toBe(3);
  const sources = [];
  for (const { id } of listed) sources.push((await open<{ source: string }>(JSON.parse((await f.call(`/${id}`, f.alice.token)).body.sealed), key)).source);
  expect(sources).toEqual(["three", "two", "one"]);

  expect((await f.call(`?tag=${tag}`, f.bob.token)).body.versions).toEqual([]);
  expect((await f.call(`/${listed[0]!.id}`, f.bob.token)).status).toBe(404);
});

test("a file keeps its newest versions", async () => {
  const f = await fixture();
  const key = await deriveKey("correct horse battery", { ...newKdf(), iterations: 100_000 });
  const tag = await pathTag("a.md", key);
  const sealed = JSON.stringify(await seal({ source: "x" }, key));
  const versions = Array.from({ length: KEEP_VERSIONS + 5 }, () => ({ tag, sealed }));
  expect((await f.call("", f.alice.token, { versions })).body).toEqual({ saved: KEEP_VERSIONS + 5 });
  expect(((await f.call(`?tag=${tag}`, f.alice.token)).body.versions as unknown[]).length).toBe(KEEP_VERSIONS);
});
