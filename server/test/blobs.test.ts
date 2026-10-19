import { afterEach, test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.ts";
import { Accounts } from "../accounts.ts";
import { Billing } from "../billing.ts";
import { Blobs, createBlobApi } from "../blobs.ts";
import { CHUNK_BYTES, chunkStoredBytes, decryptChunk, encryptChunk, newBlobRef, type BlobRef } from "../../src/blob-store.ts";
import { verifiedAccount } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

async function fixture(freeBytes = 64 * 1024 * 1024) {
  const root = mkdtempSync(join(tmpdir(), "readm3-blobs-"));
  const store = new Store(join(root, "test.sqlite"));
  const accounts = new Accounts(store.db, "http://localhost", async () => {});
  const billing = new Billing(store, null);
  const blobs = new Blobs(store, billing, { dir: join(root, "blobs"), freeBytes, microsPerGibMonth: 50_000, topups: () => true });
  const api = createBlobApi(blobs, accounts);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => await api(request) || new Response("Missing", { status: 404 }) });
  cleanup.push(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });
  const alice = await verifiedAccount(store, "blob_alice");
  const bob = await verifiedAccount(store, "blob_bob");
  const base = `http://127.0.0.1:${server.port}/api/v1/blobs`;
  accounts.origin = new URL(base).origin;
  const call = (path: string, token: string, method = "GET", body?: BodyInit) =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body });
  async function put(ref: BlobRef, bytes: Uint8Array, token = alice.token) {
    for (let n = 0, start = 0; start < Math.max(1, bytes.length); n++, start += CHUNK_BYTES) {
      const response = await call(`/${ref.id}/${n}?size=${ref.size}`, token, "PUT", await encryptChunk(ref, n, bytes.subarray(start, start + CHUNK_BYTES)) as BodyInit);
      if (!response.ok) return response;
      if (start + CHUNK_BYTES >= bytes.length) break;
    }
    return call(`/${ref.id}/complete`, token, "POST");
  }
  return { root, store, billing, blobs, alice, bob, call, put };
}

test("a signed-in account stores a multi-chunk file and reads it back; nobody else can", async () => {
  const f = await fixture();
  expect((await f.call("", "nope")).status).toBe(401);
  const bytes = new Uint8Array(CHUNK_BYTES + 1234).map((_, i) => i % 251);
  const ref = newBlobRef(bytes.length);
  expect((await f.put(ref, bytes)).status).toBe(200);
  const account = await (await f.call("", f.alice.token)).json();
  expect(account.blobs).toEqual([expect.objectContaining({ id: ref.id, size: bytes.length, complete: true, chunks: 2 })]);
  expect(account.usedBytes).toBe(bytes.length + 32);
  const back = await Promise.all([0, 1].map(async (n) => decryptChunk(ref, n, new Uint8Array(await (await f.call(`/${ref.id}/${n}`, f.alice.token)).arrayBuffer()))));
  expect(Buffer.concat(back)).toEqual(Buffer.from(bytes));
  expect((await f.call(`/${ref.id}/0`, f.bob.token)).status).toBe(404);
  expect((await f.call(`/${ref.id}/0?size=${ref.size}`, f.alice.token, "PUT", new Uint8Array(chunkStoredBytes(ref.size, 0)))).status).toBe(409);
  expect((await f.call(`/${ref.id}`, f.alice.token, "DELETE")).status).toBe(200);
  expect((await (await f.call("", f.alice.token)).json()).usedBytes).toBe(0);
  expect(existsSync(join(f.root, "blobs", f.alice.user.id, ref.id))).toBe(false);
});

test("a file must arrive whole before it is complete, and chunks must be the declared size", async () => {
  const f = await fixture();
  const ref = newBlobRef(CHUNK_BYTES + 1);
  expect((await f.call(`/${ref.id}/0?size=${ref.size}`, f.alice.token, "PUT", new Uint8Array(10))).status).toBe(400);
  expect((await f.call(`/${ref.id}/2?size=${ref.size}`, f.alice.token, "PUT", new Uint8Array(17))).status).toBe(400);
  expect((await f.call(`/${ref.id}/1?size=${ref.size}`, f.alice.token, "PUT", new Uint8Array(17))).status).toBe(200);
  expect((await f.call(`/${ref.id}/complete`, f.alice.token, "POST")).status).toBe(409);
  expect((await f.call(`/${ref.id}/0?size=${6 * 1024 ** 3}`, f.alice.token, "PUT", new Uint8Array(1))).status).toBe(413);
});

test("past the free allowance a new upload needs a balance, and storage is charged once an hour", async () => {
  const f = await fixture(1024);
  const small = newBlobRef(900);
  expect((await f.put(small, new Uint8Array(900))).status).toBe(200);
  const over = newBlobRef(900);
  const refused = await f.put(over, new Uint8Array(900));
  expect(refused.status).toBe(402);
  expect((await refused.json()).error).toContain("pay as you go");
  f.billing.credit(f.alice.user.id, 5_000_000, "test-topup", "test");
  expect((await f.put(over, new Uint8Array(900))).status).toBe(200);
  const at = new Date("2026-10-19T12:30:00Z");
  expect(f.blobs.tick(at).charged).toBe(1);
  expect(f.blobs.tick(at).charged).toBe(0);
  expect(f.billing.balance(f.alice.user.id)).toBeLessThan(5_000_000);
  expect(f.billing.balance(f.bob.user.id)).toBe(0);
});

test("an upload abandoned half way stops counting after two days", async () => {
  const f = await fixture();
  const ref = newBlobRef(CHUNK_BYTES + 1);
  expect((await f.call(`/${ref.id}/1?size=${ref.size}`, f.alice.token, "PUT", new Uint8Array(17))).status).toBe(200);
  expect(f.blobs.used(f.alice.user.id)).toBe(17);
  f.blobs.tick(new Date(Date.now() + 3 * 24 * 3600 * 1000));
  expect(f.blobs.used(f.alice.user.id)).toBe(0);
});
