/**
 * readm3's hosted MCP server at https://readm3.com/mcp: stateless JSON-RPC over
 * Streamable HTTP (POST, one JSON answer per request, no session), so any MCP
 * client can add it by URL with no login. Its one tool is `read_url`, the
 * document reader, metered by server/read-gate.ts like the REST endpoint.
 */
import { HttpError } from "./store.ts";
import { DEFAULT_READ_CHARS, MAX_READ_CHARS, readUrl, type ReadOptions } from "./read.ts";

const PROTOCOL = "2025-06-18";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

export const READ_URL_TOOL = {
  name: "read_url",
  title: "Read a document at a URL",
  description:
    "Fetch a document by URL and return its text: PDFs (arXiv papers, reports), web pages, Word, Excel, PowerPoint, OpenDocument, EPUB, Markdown and other text. " +
    "Use it to summarize, quote or answer questions about a link. Returns title, kind, page count, character count, whether the text was truncated, and the text. " +
    `maxChars caps the text (default ${DEFAULT_READ_CHARS.toLocaleString("en-US")}, up to ${MAX_READ_CHARS.toLocaleString("en-US")}). ` +
    "No account needed; a free hourly allowance, then an x402 reader pass.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "An http(s) URL on the public internet." },
      maxChars: { type: "integer", minimum: 1000, maximum: MAX_READ_CHARS },
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id, x-payment, payment-signature, x-crawl-pass, x-power-key",
  "access-control-expose-headers": "payment-required, x-payment-response",
  "cache-control": "no-store",
};

const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const failure = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function answer(message: Rpc, options: ReadOptions): Promise<unknown | null> {
  const { id, method, params = {} } = message;
  // A notification gets no answer.
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return reply(id, {
        protocolVersion: SUPPORTED.has(asked) ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "readm3", title: "readm3 document reader", version: "1.0.0" },
        instructions: "Call read_url with a link to get the document's text, then summarize or answer from it.",
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: [READ_URL_TOOL] });
    case "tools/call": {
      if (params.name !== "read_url") return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args.url !== "string" || !args.url) return failure(id, -32602, "url is required.");
      try {
        const result = await readUrl(args.url, { ...options, maxChars: typeof args.maxChars === "number" ? args.maxChars : undefined });
        const { text, ...about } = result;
        return reply(id, {
          content: [
            { type: "text", text: `# ${result.title}\n\nSource: ${result.finalUrl} (${result.kind}${result.pages ? `, ${result.pages} pages` : ""}, ${result.chars.toLocaleString("en-US")} characters${result.truncated ? ", truncated" : ""})\n\n${text}` },
          ],
          structuredContent: { ...about, text },
          isError: false,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : "The document could not be read.";
        return reply(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}

/** The /mcp route. Null for any other path. */
export async function handleMcp(request: Request, options: ReadOptions = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST")
    return Response.json(failure(null, -32000, "POST JSON-RPC to this URL; there is no event stream."), { status: 405, headers: { ...cors, allow: "POST, OPTIONS" } });
  let payload: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) throw new HttpError(413, "Request too large.");
    payload = JSON.parse(raw);
  } catch {
    return Response.json(failure(null, -32700, "Parse error"), { status: 400, headers: cors });
  }
  const batch = Array.isArray(payload);
  const messages = (batch ? payload : [payload]) as Rpc[];
  if (!messages.length || messages.length > 10) return Response.json(failure(null, -32600, "Invalid request"), { status: 400, headers: cors });
  const answers = (await Promise.all(messages.map((m) => (m && typeof m === "object" ? answer(m, options) : Promise.resolve(failure(null, -32600, "Invalid request")))))).filter((a) => a !== null);
  if (!answers.length) return new Response(null, { status: 202, headers: cors });
  return Response.json(batch ? answers : answers[0], { headers: cors });
}
