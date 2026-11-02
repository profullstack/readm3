import { describe, expect, test } from "bun:test";
import { checkUrl, htmlToText, isPrivateAddress, readUrl } from "../read.ts";
import { createReadGate } from "../read-gate.ts";
import { handleMcp } from "../read-mcp.ts";

/** A one-page PDF whose page says `words`, with correct xref offsets. */
function tinyPdf(words: string): Uint8Array<ArrayBuffer> {
  const stream = `BT /F1 18 Tf 72 720 Td (${words}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const publicDns = async () => ["93.184.216.34"];
const serve = (routes: Record<string, () => Response>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const key = new URL(String(input instanceof Request ? input.url : input)).href;
    const route = routes[key];
    return route ? route() : new Response("missing", { status: 404 });
  }) as typeof fetch;

describe("address checks", () => {
  test("private, loopback, link-local and mapped addresses are refused", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  test("URLs aimed inside are refused before any fetch", async () => {
    await expect(checkUrl("http://127.0.0.1/")).rejects.toThrow("public");
    await expect(checkUrl("http://localhost:3000/")).rejects.toThrow("public");
    await expect(checkUrl("file:///etc/passwd")).rejects.toThrow("http(s)");
    await expect(checkUrl("http://user:pw@example.com/")).rejects.toThrow("password");
    await expect(checkUrl("http://sneaky.example/", async () => ["93.184.216.34", "10.0.0.5"])).rejects.toThrow("public");
    await expect(checkUrl("https://example.com:22/", publicDns)).rejects.toThrow("port");
    expect((await checkUrl("https://example.com/a.pdf", publicDns)).href).toBe("https://example.com/a.pdf");
  });
  test("a redirect into the private network is refused", async () => {
    const fetchImpl = serve({ "https://example.com/go": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }) });
    await expect(readUrl("https://example.com/go", { fetchImpl, resolve: publicDns })).rejects.toThrow("public");
  });
});

describe("reading", () => {
  test("a PDF comes back as its text", async () => {
    const pdf = tinyPdf("Intuition in Einsteinian Physics");
    const fetchImpl = serve({ "https://arxiv.org/pdf/2106.01820": () => new Response(pdf, { headers: { "content-type": "application/pdf" } }) });
    const read = await readUrl("https://arxiv.org/pdf/2106.01820", { fetchImpl, resolve: publicDns });
    expect(read.kind).toBe("pdf");
    expect(read.pages).toBe(1);
    expect(read.bytes).toBe(pdf.length);
    expect(read.text).toContain("Intuition in Einsteinian Physics");
    expect(read.title).toContain("Intuition");
  });
  test("a web page keeps its words and drops scripts and navigation", async () => {
    const html = `<!doctype html><html><head><title>A &amp; B</title><script>evil()</script></head><body><nav>Home Docs</nav><article><h1>Heading</h1><p>First paragraph.</p><ul><li>one</li><li>two</li></ul></article></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("A & B");
    expect(text).toContain("# Heading");
    expect(text).toContain("First paragraph.");
    expect(text).toContain("- one");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("Home Docs");
  });
  test("redirects are followed, text is capped, binaries are refused", async () => {
    const fetchImpl = serve({
      "https://example.com/old": () => new Response(null, { status: 301, headers: { location: "/notes.md" } }),
      "https://example.com/notes.md": () => new Response("# Notes\n\n" + "x".repeat(5000), { headers: { "content-type": "text/markdown" } }),
      "https://example.com/bin": () => new Response(new Uint8Array([1, 0, 2, 0, 3]), { headers: { "content-type": "application/octet-stream" } }),
      "https://example.com/img": () => new Response("GIF89a", { headers: { "content-type": "image/gif" } }),
    });
    const read = await readUrl("https://example.com/old", { fetchImpl, resolve: publicDns, maxChars: 1000 });
    expect(read.finalUrl).toBe("https://example.com/notes.md");
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBe(1000);
    await expect(readUrl("https://example.com/bin", { fetchImpl, resolve: publicDns })).rejects.toThrow("binary");
    await expect(readUrl("https://example.com/img", { fetchImpl, resolve: publicDns })).rejects.toThrow("not read");
  });
});

describe("read gate", () => {
  const env = { COINPAY_X402_KEY: "cp_live_test", CRAWL_PAY_TO: "0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5", READM3_FREE_READS: "2" };
  const ask = (gate: ReturnType<typeof createReadGate>, path: string, headers: Record<string, string> = {}) =>
    gate.handle(new Request(`https://readm3.com${path}`, { method: "POST", headers: { "x-real-ip": "203.0.113.9", ...headers } }));

  test("free reads, then a 402 with an x402 offer", async () => {
    const gate = createReadGate(env);
    expect(await ask(gate, "/api/v1/read")).toBeNull();
    expect(await ask(gate, "/mcp")).toBeNull();
    const sold = await ask(gate, "/api/v1/read");
    expect(sold?.status).toBe(402);
    expect(sold?.headers.get("payment-required")).toBeTruthy();
  });
  test("other paths are not this gate's business", async () => {
    const gate = createReadGate({ ...env, READM3_FREE_READS: "1" });
    for (let i = 0; i < 5; i++) expect(await ask(gate, "/api/v1/pastes")).toBeNull();
  });
  test("a verified account is never metered; a made-up cookie or token is", async () => {
    const gate = createReadGate({ ...env, READM3_FREE_READS: "1" }, (token) => token === "good");
    for (let i = 0; i < 3; i++) expect(await ask(gate, "/api/v1/read", { authorization: "Bearer good" })).toBeNull();
    for (let i = 0; i < 3; i++) expect(await ask(gate, "/api/v1/read", { cookie: "__Host-readm3_session=good" })).toBeNull();
    expect((await ask(gate, "/api/v1/read", { authorization: "Bearer bad" }))?.status).toBe(401);
    expect(await ask(gate, "/api/v1/read", { cookie: "__Host-readm3_session=fake", "x-real-ip": "198.51.100.7" })).toBeNull();
    expect((await ask(gate, "/api/v1/read", { cookie: "__Host-readm3_session=fake", "x-real-ip": "198.51.100.7" }))?.status).toBe(402);
  });
});

describe("hosted MCP", () => {
  const rpc = (body: unknown) => handleMcp(new Request("https://readm3.com/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { resolve: publicDns, fetchImpl: serve({ "https://example.com/a.md": () => new Response("# Hello\n\nworld", { headers: { "content-type": "text/markdown" } }) }) });

  test("initialize, list and call read_url", async () => {
    const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))!.json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }))!.status).toBe(202);
    const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))!.json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["read_url"]);
    const call = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_url", arguments: { url: "https://example.com/a.md" } } }))!.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0]!.text).toContain("world");
  });
  test("a refused URL is a tool error, not a crash", async () => {
    const call = (await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_url", arguments: { url: "http://127.0.0.1/" } } }))!.json()) as { result: { isError: boolean } };
    expect(call.result.isError).toBe(true);
  });
});
