import { test, expect, describe } from "bun:test";
import { Store, id } from "../store.ts";
import { createApi } from "../api.ts";
import { PASTE_MAX_BYTES, pasteTitle } from "../pastes.ts";

function fixture() {
  const store = new Store(":memory:");
  const api = createApi(store, "http://localhost");
  // Rate limits are per address and live for the whole process, so each fixture gets its own.
  const address = id();
  async function call(route: string, method = "GET", data?: unknown, ip = address, origin?: string) {
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
    expect(pasteTitle(undefined, "{}", "json")).toBe("paste.json");
    expect(pasteTitle("config", "", "yaml")).toBe("config.yml");
    expect(pasteTitle("settings.conf", "", "ini")).toBe("settings.conf");
    expect(pasteTitle("Dockerfile", "", "dockerfile")).toBe("Dockerfile");
  });

  test("detects the language of a paste from its content and reports it with a mime type", async () => {
    const { call } = fixture();
    const json = await call("pastes", "POST", { source: '{"fleet":["a","b"],"live":true}' });
    expect(json.status).toBe(201);
    expect(json.data.title).toBe("paste.json");
    expect(json.data.language).toBe("json");
    expect(json.data.mime).toBe("application/json");
    expect(json.data.raw).toBe(`${json.data.url}/raw`);
    const read = await call(`pastes/${tokenOf(json.data.url)}`);
    expect(read.data.language).toBe("json");
    expect(read.data.mime).toBe("application/json");
    const python = await call("pastes", "POST", { source: "import os\n\ndef main():\n    print(os.getcwd())\n\nif __name__ == '__main__':\n    main()\n" });
    expect(python.data.title).toBe("paste.py");
    expect(python.data.language).toBe("python");
    const prose = await call("pastes", "POST", { source: "# Notes\n\nJust words.\n" });
    expect(prose.data.language).toBe("markdown");
    expect(prose.data.title).toBe("Notes.md");
  });

  test("the title's extension decides the language, and an explicit language overrides both", async () => {
    const { call } = fixture();
    const named = await call("pastes", "POST", { source: "a: 1\nb: 2\n", title: "compose.yml" });
    expect(named.data.language).toBe("yaml");
    expect(named.data.title).toBe("compose.yml");
    const bare = await call("pastes", "POST", { source: "SELECT 1 FROM t WHERE x = 2 ORDER BY x;", title: "report" });
    expect(bare.data.language).toBe("sql");
    expect(bare.data.title).toBe("report.sql");
    const forced = await call("pastes", "POST", { source: '{"a":1}', title: "data.txt", language: "json" });
    expect(forced.data.language).toBe("json");
    expect(forced.data.title).toBe("data.txt");
    expect((await call("pastes", "POST", { source: "x", language: "klingon" })).status).toBe(400);
  });

  test("serves the raw text as plain text inline, and with its own type as a download", async () => {
    const { store, call } = fixture();
    const api = createApi(store, "http://localhost");
    const created = await call("pastes", "POST", { source: "<script>alert(1)</script>", title: "page.html" });
    const token = tokenOf(created.data.url);
    const inline = (await api(new Request(`http://localhost/api/v1/pastes/${token}/raw`), "1.2.3.4"))!;
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(inline.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''page.html");
    expect(inline.headers.get("content-security-policy")).toContain("sandbox");
    expect(await inline.text()).toBe("<script>alert(1)</script>");
    const download = (await api(new Request(`http://localhost/api/v1/pastes/${token}/raw?download=1`), "1.2.3.4"))!;
    expect(download.headers.get("content-type")).toBe("text/html");
    expect(download.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect((await api(new Request(`http://localhost/api/v1/pastes/${"b".repeat(43)}/raw`), "1.2.3.4"))!.status).toBe(404);
  });

  test("a PDF or image paste is base64 in, its own bytes out", async () => {
    const { store, call } = fixture();
    const api = createApi(store, "http://localhost");
    const bytes = Buffer.from("%PDF-1.4 not really");
    const created = await call("pastes", "POST", { source: bytes.toString("base64"), title: "spec.pdf" });
    expect(created.status).toBe(201);
    expect(created.data.language).toBe("binary");
    expect(created.data.mime).toBe("application/pdf");
    expect(created.data.title).toBe("spec.pdf");
    const token = tokenOf(created.data.url);
    const raw = (await api(new Request(`http://localhost/api/v1/pastes/${token}/raw`), "1.2.3.4"))!;
    expect(raw.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await raw.arrayBuffer()).equals(bytes)).toBe(true);
    const svg = await call("pastes", "POST", { source: Buffer.from("<svg onload=alert(1)/>").toString("base64"), title: "icon.svg" });
    const svgRaw = (await api(new Request(`http://localhost/api/v1/pastes/${tokenOf(svg.data.url)}/raw`), "1.2.3.4"))!;
    expect(svgRaw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await call("pastes", "POST", { source: "plain text, not base64!", title: "x.pdf" })).status).toBe(400);
  });

  test("a paste stored before languages existed reads as Markdown", async () => {
    const { store, call } = fixture();
    const created = await call("pastes", "POST", { source: "# Old\n" });
    store.run("UPDATE pastes SET language=NULL WHERE id=?", created.data.id);
    const read = await call(`pastes/${tokenOf(created.data.url)}`);
    expect(read.data.language).toBe("markdown");
    expect(read.data.mime).toBe("text/markdown");
  });
});
