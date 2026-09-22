import { binaryType, languageForName, languageOf, MARKDOWN, type BinaryType, type Language } from "../src/code.ts";
import type { WorkspaceDocument } from "../src/sync-schema.ts";

/**
 * A workspace file: any text (Markdown renders, everything else is highlighted code),
 * or a PDF or image whose bytes are base64 in `source`. `language` is stored only when
 * the name had no known extension and the content was sniffed on import.
 */
export type Document = WorkspaceDocument;

export interface Workspace {
  documents: Document[];
  active: string;
  name: string;
}

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 1000;
const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "venv", "__pycache__", ".git"]);
/** Files that are never text and never viewable, so they are skipped without being read. */
const NEVER = /\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|o|a|class|jar|war|wasm|bin|dat|db|sqlite|sqlite3|mp3|mp4|m4a|mov|avi|mkv|webm|ogg|wav|flac|woff2?|ttf|otf|eot|psd|ai|doc|docx|xls|xlsx|ppt|pptx|iso|dmg|pkg|deb|rpm|apk|lock)$/i;

/** Whether a path may enter the workspace: not hidden, not build output, not a known binary blob. */
export function accepts(path: string): boolean {
  return !NEVER.test(path) && path.split("/").every((part) => part && !part.startsWith(".") && !IGNORED.has(part));
}

/** What a document is on screen: rendered Markdown, highlighted code, or a browser-viewed binary. */
export type DocumentKind = { kind: "markdown"; language: Language } | { kind: "code"; language: Language } | { kind: "binary"; binary: BinaryType };

export function kindOf(doc: Pick<Document, "path" | "language">): DocumentKind {
  const binary = binaryType(doc.path);
  if (binary) return { kind: "binary", binary };
  const language = languageOf(doc.language ?? languageForName(doc.path)?.id ?? MARKDOWN);
  return language.id === MARKDOWN ? { kind: "markdown", language } : { kind: "code", language };
}

/** The bytes of a document: decoded base64 for a binary, UTF-8 for text. */
export function bytesOf(doc: Document): Uint8Array {
  if (!binaryType(doc.path)) return new TextEncoder().encode(doc.source);
  try {
    const raw = atob(doc.source);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch { return new Uint8Array(); }
}

/** Base64 of a file's bytes, built in chunks so a multi-megabyte PDF does not blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const aDir = i < left.length - 1;
    const bDir = i < right.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    if (!aDir) {
      const aReadme = /^readme\b/i.test(left[i]);
      const bReadme = /^readme\b/i.test(right[i]);
      if (aReadme !== bReadme) return aReadme ? -1 : 1;
    }
    const order = left[i].localeCompare(right[i], undefined, { numeric: true, sensitivity: "base" });
    if (order) return order;
  }
  return left.length - right.length;
}

export function rawUrl(input: string): URL {
  const url = new URL(input);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Use a public HTTP or HTTPS file URL.");
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/");
    if (parts[3] === "blob" && parts.length > 5) {
      url.hostname = "raw.githubusercontent.com";
      parts.splice(3, 1);
      url.pathname = parts.join("/");
    }
  }
  return url;
}

let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("readm3", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Browser storage is blocked."));
  });
}

export async function restore(): Promise<Workspace | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction("workspace").objectStore("workspace").get("current");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function persist(workspace: Workspace): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("workspace", "readwrite");
    transaction.objectStore("workspace").put(workspace, "current");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
