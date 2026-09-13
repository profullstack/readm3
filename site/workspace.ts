export interface Document {
  path: string;
  source: string;
}

export interface Workspace {
  documents: Document[];
  active: string;
  name: string;
}

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 1000;
const MARKDOWN = /\.(?:md|markdown|mdown|mkd|mdx)$/i;
const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "venv", "__pycache__"]);

export function accepts(path: string): boolean {
  return MARKDOWN.test(path) && path.split("/").every((part) => !part.startsWith(".") && !IGNORED.has(part));
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
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Use a public HTTP or HTTPS Markdown URL.");
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
