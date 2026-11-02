/**
 * Read a document at a URL and return its words: the reader behind
 * `GET|POST /api/v1/read` and the hosted MCP's `read_url` tool.
 *
 * A PDF is read with unpdf (pdf.js, no dependencies of its own), a web page is
 * cut down to its text, an office document or e-book goes through extract.ts,
 * and anything textual (Markdown, JSON, CSV, code) comes back as it is.
 *
 * The fetch is the dangerous part, because the URL is whatever a stranger typed:
 * only http(s) on the default or a high port, every hop's host resolved and
 * refused when any address is private, loopback, link-local or otherwise not on
 * the public internet, redirects followed by hand so each one is checked, and the
 * body cut off at a size cap.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./store.ts";
import { decodeEntities, documentText, extractable } from "./extract.ts";

/** The most a document may weigh: a long paper or a book chapter, not a dataset. */
export const MAX_READ_BYTES = 25 * 1024 * 1024;
/** Characters returned by default, and the most a caller may ask for. */
export const DEFAULT_READ_CHARS = 100_000;
export const MAX_READ_CHARS = 400_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

export type ReadResult = {
  url: string;
  finalUrl: string;
  title: string;
  kind: "pdf" | "html" | "office" | "text";
  mime: string;
  pages?: number;
  bytes: number;
  chars: number;
  truncated: boolean;
  text: string;
};

export type ReadOptions = {
  maxChars?: number;
  fetchImpl?: typeof fetch;
  /** Every address a host name resolves to. Tests replace it. */
  resolve?: (host: string) => Promise<string[]>;
};

const defaultResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Number(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Whether an address is somewhere a stranger's URL must never reach. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = v4Number(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((v4Number(base) & mask) >>> 0);
    });
  }
  if (family === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (a === "::" || a === "::1") return true;
    // IPv4-mapped and -translated addresses carry the v4 address that matters.
    const mapped = a.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:/.test(a)) return true;
    const first = parseInt(a.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (first === 0x2001 && parseInt(a.split(":")[1] || "0", 16) === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

/** The URL, checked: http(s), no credentials, a public host on an ordinary port. */
export async function checkUrl(raw: string, resolve = defaultResolve): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "url must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "url must be an absolute http(s) URL.");
  if (url.username || url.password) throw new HttpError(400, "A URL with a user name or password is not read.");
  const port = url.port ? Number(url.port) : 0;
  if (port && port !== 80 && port !== 443 && port < 1024) throw new HttpError(400, "That port is not read.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    throw new HttpError(400, "Only public addresses are read.");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new HttpError(422, `${host} does not resolve.`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new HttpError(400, "Only public addresses are read.");
  return url;
}

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max)
    throw new HttpError(413, `The document is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, `The document is larger than ${Math.round(max / 1024 / 1024)} MB.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

/** Fetch with each redirect checked like the first URL. */
export async function fetchDocument(raw: string, { fetchImpl = fetch, resolve = defaultResolve }: ReadOptions = {}) {
  let url = await checkUrl(raw, resolve);
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal: deadline,
        headers: {
          "user-agent": "readm3-reader/1.0 (+https://readm3.com/docs#read)",
          accept: "application/pdf,text/html;q=0.9,text/markdown,text/plain;q=0.8,*/*;q=0.5",
        },
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "took too long" : "could not be reached";
      throw new HttpError(502, `${url.host} ${reason}.`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new HttpError(502, "Too many redirects.");
      url = await checkUrl(new URL(response.headers.get("location")!, url).href, resolve);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, `${url.host} answered ${response.status}.`);
    }
    const bytes = await readCapped(response, MAX_READ_BYTES);
    return { url, bytes, mime: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() };
  }
}

const BLOCK_TAGS = /<\/?(?:p|div|section|article|main|header|footer|li|ul|ol|tr|table|blockquote|pre|figure|figcaption|dd|dt|dl|br|hr)\b[^>]*>/gi;

/** A web page's title and its readable words, as light Markdown. */
export function htmlToText(html: string): { title: string; text: string } {
  const pick = (re: RegExp) => decodeEntities((html.match(re)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  // The article when the page marks one, else the body.
  const main = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2]
    ?? html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = main
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, " ").trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, " ");
  return {
    title,
    text: decodeEntities(text)
      .split("\n")
      .map((line) => line.replace(/[ \t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

async function pdfText(bytes: Uint8Array): Promise<{ title: string; text: string; pages: number }> {
  const { getDocumentProxy, extractText, getMeta } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes);
  } catch {
    throw new HttpError(422, "The PDF could not be opened.");
  }
  try {
    const meta = await getMeta(pdf).catch(() => null);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const body = (text as string[]).map((page) => page.trim()).filter(Boolean).join("\n\n");
    const metaTitle = String((meta?.info as Record<string, unknown> | undefined)?.Title ?? "").trim();
    // Many PDFs carry a file name ("Chapter 1_Schutz", "Microsoft Word - x.docx") as their title.
    const useful = metaTitle && !/[_]|\.(docx?|tex|pdf)$|^untitled$|^microsoft /i.test(metaTitle);
    const firstLine = body.split("\n").find((line) => line.trim().length > 3)?.trim() ?? "";
    return { title: useful ? metaTitle : firstLine.slice(0, 200), text: body, pages: totalPages };
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|ld\+json|rss\+xml|atom\+xml|x-ndjson|toml))/;

/** Fetch `raw` and return its text, cut to `maxChars`. */
export async function readUrl(raw: string, options: ReadOptions = {}): Promise<ReadResult> {
  const maxChars = Math.min(Math.max(Math.floor(options.maxChars ?? DEFAULT_READ_CHARS), 1_000), MAX_READ_CHARS);
  const { url, bytes, mime } = await fetchDocument(raw, options);
  // pdf.js takes ownership of the buffer and detaches it, so measure first.
  const size = bytes.length;
  const path = decodeURIComponent(url.pathname);
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  let kind: ReadResult["kind"];
  let title = "";
  let text: string;
  let pages: number | undefined;
  if (mime === "application/pdf" || head.startsWith("%pdf-")) {
    ({ title, text, pages } = await pdfText(bytes));
    kind = "pdf";
  } else if (mime === "text/html" || mime === "application/xhtml+xml" || head.startsWith("<!doctype html") || head.startsWith("<html")) {
    ({ title, text } = htmlToText(new TextDecoder().decode(bytes)));
    kind = "html";
  } else if (extractable(path)) {
    try {
      text = (await documentText(path, bytes)).text;
    } catch {
      throw new HttpError(422, "The document could not be read.");
    }
    kind = "office";
  } else if (TEXT_MIME.test(mime) || !mime || mime === "application/octet-stream") {
    const sample = bytes.subarray(0, 8192);
    if (sample.includes(0)) throw new HttpError(415, "That is a binary file; the reader takes PDFs, web pages, office documents and text.");
    text = new TextDecoder().decode(bytes);
    kind = "text";
  } else {
    throw new HttpError(415, `${mime} is not read; the reader takes PDFs, web pages, office documents and text.`);
  }
  if (!title) title = path.split("/").filter(Boolean).at(-1) ?? url.hostname;
  if (!text.trim()) throw new HttpError(422, kind === "pdf" ? "The PDF has no text layer (a scan); it would need OCR." : "The document has no readable text.");
  const truncated = text.length > maxChars;
  return {
    url: raw,
    finalUrl: url.href,
    title,
    kind,
    mime: mime || (kind === "pdf" ? "application/pdf" : "text/plain"),
    ...(pages ? { pages } : {}),
    bytes: size,
    chars: text.length,
    truncated,
    text: truncated ? text.slice(0, maxChars) : text,
  };
}
