import { test, expect, describe } from "bun:test";
import { Store, id } from "../store.ts";
import { createApi } from "../api.ts";
import { PASTE_MAX_BYTES, pasteTitle } from "../pastes.ts";

function fixture() {
  const store = new Store(":memory:");
  const api = createApi(store, "http://localhost");
  async function call(route: string, method = "GET", data?: unknown, ip = "1.2.3.4", origin?: string) {
    const response = (await api(
      new Request("http://localhost/api/v1/" + route, {
        method,
        headers: {
          ...(data === undefined ? {} : { "content-type": "application/json" }),
          ...(origin ? { origin } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      ip,
    ))!;
    return { status: response.status, data: (await response.json()) as any };
  }
  return { store, call };
}

const tokenOf = (url: string) => url.match(/\/p\/([A-Za-z0-9_-]{43})$/)![1]!;

describe("anonymous pastes", () => {
  test("creates a paste without an account and reads it back by its secret link", async () => {
    const { store, call } = fixture();
    const source = "# Fleet notes\n\nWe test in prod.\n";
    const created = await call("pastes", "POST", { source });
    expect(created.status).toBe(201);
    expect(created.data.url).toMatch(/^http:\/\/localhost\/p\/[A-Za-z0-9_-]{43}$/);
    expect(created.data.title).toBe("Fleet notes.md");
    expect(Date.parse(created.data.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    const token = tokenOf(created.data.url);
    expect(store.get("SELECT id FROM pastes WHERE tokenHash=?", token)).toBeNull();
    const read = await call(`pastes/${token}`);
    expect(read.status).toBe(200);
    expect(read.data.source).toBe(source);
    expect(read.data.title).toBe("Fleet notes.md");
    expect(read.data.bytes).toBe(Buffer.byteLength(source));
  });

  test("honours a title and an expiry, and rejects a bad expiry or an empty body", async () => {
    const { call } = fixture();
    const created = await call("pastes", "POST", { source: "hello", title: "notes", expiresIn: "1h" });
    expect(created.status).toBe(201);
    expect(created.data.title).toBe("notes.md");
    expect(Date.parse(created.data.expiresAt) - Date.now()).toBeLessThan(3601 * 1000);
    expect((await call("pastes", "POST", { source: "hello", expiresIn: "1y" })).status).toBe(400);
    expect((await call("pastes", "POST", { source: "   " })).status).toBe(400);
    expect((await call("pastes", "POST", { title: "x" })).status).toBe(400);
  });

  test("caps the size", async () => {
    const { call } = fixture();
    const big = await call("pastes", "POST", { source: "x".repeat(PASTE_MAX_BYTES + 1) });
    expect(big.status).toBe(413);
    expect((await call("pastes", "POST", { source: "x".repeat(PASTE_MAX_BYTES) })).status).toBe(201);
  });

  test("an unknown, expired or deleted link is a 404, and deletion needs only the link", async () => {
    const { store, call } = fixture();
    expect((await call(`pastes/${"a".repeat(43)}`)).status).toBe(404);
    const created = await call("pastes", "POST", { source: "gone soon" });
    const token = tokenOf(created.data.url);
    store.run("UPDATE pastes SET expiresAt=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), created.data.id);
    expect((await call(`pastes/${token}`)).status).toBe(404);
    const kept = await call("pastes", "POST", { source: "still here" });
    expect(store.get("SELECT id FROM pastes WHERE id=?", created.data.id)).toBeNull();
    const keptToken = tokenOf(kept.data.url);
    expect((await call(`pastes/${keptToken}`, "DELETE")).status).toBe(200);
    expect((await call(`pastes/${keptToken}`)).status).toBe(404);
    expect((await call(`pastes/${keptToken}`, "DELETE")).status).toBe(404);
  });

  test("only reading, creating and deleting are possible", async () => {
    const { call } = fixture();
    const created = await call("pastes", "POST", { source: "fixed" });
    const token = tokenOf(created.data.url);
    expect((await call(`pastes/${token}`, "PATCH", { source: "changed" })).status).toBe(405);
    expect((await call("pastes")).status).toBe(405);
    expect((await call(`pastes/${token}`)).data.source).toBe("fixed");
  });

  test("rate-limits creation per address", async () => {
    const { call } = fixture();
    const ip = id();
    for (let i = 0; i < 10; i++) expect((await call("pastes", "POST", { source: `p${i}` }, ip)).status).toBe(201);
    expect((await call("pastes", "POST", { source: "one too many" }, ip)).status).toBe(429);
    expect((await call("pastes", "POST", { source: "someone else" }, id())).status).toBe(201);
  });

  test("refuses a cross-origin browser request", async () => {
    const { call } = fixture();
    expect((await call("pastes", "POST", { source: "csrf" }, "1.1.1.1", "https://evil.example")).status).toBe(403);
    expect((await call("pastes", "POST", { source: "same" }, "1.1.1.1", "http://localhost")).status).toBe(201);
  });

  test("names the file from the title or the first heading", () => {
    expect(pasteTitle("Weekly report", "")).toBe("Weekly report.md");
    expect(pasteTitle("notes.md", "")).toBe("notes.md");
    expect(pasteTitle("a/b\\c", "")).toBe("a-b-c.md");
    expect(pasteTitle(undefined, "intro\n\n# Fleet SysOps Manifesto #\n")).toBe("Fleet SysOps Manifesto.md");
    expect(pasteTitle(undefined, "no heading")).toBe("paste.md");
  });
});
