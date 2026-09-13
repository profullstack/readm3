/** Browser-safe account data contract. Only these two files may be synced. */
import { isFlavor, type Flavor } from "./flavors.ts";

export interface WorkspaceDocument { path: string; source: string }
export interface SyncedWorkspace { documents: WorkspaceDocument[]; active: string; name: string }
export interface ReaderSettings { theme?: string; flavor?: Flavor }
export const SYNC_LIMITS = { maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 33 * 1024 * 1024, maxFiles: 2 };
export const SYNC_FILES = ["settings.json", "workspace.json"] as const;
export const SYNC_POLICY = {
  files: SYNC_FILES.map((path) => ({ path, json: true })),
  never: ["account.json", "cloud.json", "sync.json"],
  ...SYNC_LIMITS,
};

export function validateSettings(value: unknown): ReaderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object.");
  const settings = value as ReaderSettings;
  if (Object.keys(settings).some((key) => !["theme", "flavor"].includes(key))) throw new Error("Only theme and flavor can be synced as settings.");
  if (settings.theme !== undefined && (typeof settings.theme !== "string" || !/^[a-z0-9-]{1,40}$/.test(settings.theme))) throw new Error("Invalid theme.");
  if (settings.flavor !== undefined && !isFlavor(settings.flavor)) throw new Error("Invalid Markdown flavor.");
  return settings;
}

export function validateWorkspace(value: unknown): SyncedWorkspace {
  if (!value || typeof value !== "object") throw new Error("Workspace must be an object.");
  const ws = value as SyncedWorkspace;
  if (Object.keys(ws).some((key) => !["name", "active", "documents"].includes(key))) throw new Error("Workspace can only contain name, active and documents.");
  if (typeof ws.name !== "string" || ws.name.length > 200 || !Array.isArray(ws.documents) || !ws.documents.length || ws.documents.length > 1000) throw new Error("Workspace needs a name and 1–1,000 Markdown files.");
  const paths = new Set<string>();
  let total = 0;
  const encoder = new TextEncoder();
  for (const doc of ws.documents) {
    if (!doc || typeof doc.path !== "string" || doc.path.length > 1024 || /[\\\x00-\x1f:]/.test(doc.path) || doc.path.split("/").some((p) => !p || p.startsWith(".")) || !/\.(md|markdown|mdown|mkd|mdx)$/i.test(doc.path) || paths.has(doc.path)) throw new Error("Workspace contains an invalid or duplicate Markdown path.");
    if (typeof doc.source !== "string") throw new Error("Markdown source must be text.");
    if (Object.keys(doc).some((key) => !["path", "source"].includes(key))) throw new Error("Documents can only contain path and source.");
    const bytes = encoder.encode(doc.source).length;
    total += bytes;
    if (bytes > 4 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error("Workspace limit: 4 MB per file and 20 MB total.");
    paths.add(doc.path);
  }
  if (!paths.has(ws.active)) throw new Error("The active document is missing.");
  return ws;
}

export function validateSyncFiles(files: Record<string, { content: string }>): void {
  for (const [path, file] of Object.entries(files)) {
    if (!(SYNC_FILES as readonly string[]).includes(path)) throw new Error(`File is not syncable: ${path}`);
    if (!file || typeof file.content !== "string") throw new Error(`${path}: content must be text.`);
    const value: unknown = JSON.parse(file.content);
    if (path === "settings.json") validateSettings(value); else validateWorkspace(value);
  }
}
