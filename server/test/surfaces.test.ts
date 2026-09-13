import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../store.ts";
import { createApi } from "../api.ts";
import { verifiedAccount } from "./fixtures.ts";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../..", import.meta.url));
const runtime = process.env.READM3_TEST_NODE ? "node" : "bun";
const entry = runtime === "node" ? "bin/readm3.mjs" : "src/cli.ts";

test("CLI and stdio MCP operate on the same documents and enforce the same edit permissions", async () => {
  const store = new Store(":memory:");
  const api = createApi(store);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      return (
        (await api(request, "surface-test")) ||
        new Response("Not found", { status: 404 })
      );
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  let client: Client | undefined;
  try {
    const { token } = await verifiedAccount(store, "surface_owner");
    async function cli(...args: string[]) {
      const process = Bun.spawn([Bun.which(runtime)!, entry, ...args], {
        cwd: root,
        env: {
          ...globalThis.process.env,
          READM3_URL: url,
          READM3_TOKEN: token,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit, stderr).toBe(0);
      return JSON.parse(stdout);
    }
    const orgs = await cli("orgs", "list");
    const doc = await cli(
      "cloud",
      "documents_create",
      "--args",
      JSON.stringify({
        orgId: orgs[0].id,
        title: "Across surfaces.md",
        source: "# From CLI",
      }),
    );
    expect(doc.version.source).toBe("# From CLI");
    client = new Client({ name: "readm3-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: Bun.which(runtime)!,
        args: [entry, "mcp"],
        cwd: root,
        env: {
          PATH: globalThis.process.env.PATH!,
          READM3_URL: url,
          READM3_TOKEN: token,
        },
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "shares_create")).toBe(
      true,
    );
    expect(tools.tools.some((tool) => tool.name === "teams_create")).toBe(true);
    const changed = await client.callTool({
      name: "documents_update",
      arguments: {
        documentId: doc.id,
        baseVersion: doc.currentVersion,
        source: "# From MCP",
      },
    });
    expect(changed.isError).not.toBe(true);
    const latest = await cli("docs", "get", doc.id);
    expect(latest.version.source).toBe("# From MCP");
    const link = await cli("docs", "share", doc.id);
    const shared = await client.callTool({
      name: "shared_get",
      arguments: { url: link.url },
    });
    expect(shared.isError).not.toBe(true);
    const denied = await client.callTool({
      name: "shared_update",
      arguments: {
        url: link.url,
        source: "# Denied",
        baseVersion: latest.currentVersion,
      },
    });
    expect(denied.isError).toBe(true);
    const versions = await cli("docs", "history", doc.id);
    expect(versions).toHaveLength(2);
    await cli("docs", "delete", doc.id);
    const missing = await client.callTool({
      name: "documents_get",
      arguments: { documentId: doc.id },
    });
    expect(missing.isError).toBe(true);
  } finally {
    await client?.close();
    server.stop(true);
    store.close();
  }
}, 30000);
