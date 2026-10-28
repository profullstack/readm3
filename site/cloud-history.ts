/**
 * The account side of a file's history (server/file-history.ts): every version a device
 * syncs is sealed with the sync key and filed under the path's tag, so the History dialog
 * on any signed-in device lists versions from all of them and can restore one.
 */
import { request, type CloudUser } from "./cloud.ts";
import { stored } from "./sync.ts";
import { open, pathTag, seal, type Envelope, type SyncKey } from "../src/sync-crypto.ts";
import type { WorkspaceDocument } from "../src/sync-schema.ts";

export interface CloudVersion { id: string; at: string; device: string; source: string; language?: string }
interface Sealed { path: string; source: string; language?: string; device: string; at: string }
type Change = { doc: WorkspaceDocument; before?: WorkspaceDocument };

/** Past this many changed files in one pass (a folder opened again), only the first are filed. */
const MAX_PER_PASS = 200;

/** Files a version for each document that changed in this sync pass, and the text it had before when the file has no history yet. */
export async function record(changes: Change[], key: SyncKey, device: string): Promise<void> {
  const at = new Date().toISOString();
  const versions = [];
  for (const { doc, before } of changes.filter(({ doc }) => !doc.blob).slice(0, MAX_PER_PASS)) {
    const tag = await pathTag(doc.path, key);
    const sealed = async (source: Pick<WorkspaceDocument, "source" | "language">, when: string, ifEmpty?: boolean) => ({
      tag, ifEmpty, sealed: JSON.stringify(await seal({ path: doc.path, source: source.source, language: source.language, device, at: when } satisfies Sealed, key)),
    });
    if (before && !before.blob && before.source !== doc.source) versions.push(await sealed(before, "", true));
    versions.push(await sealed(doc, at));
  }
  for (let i = 0; i < versions.length; i += 50) await request("file-history", "POST", { versions: versions.slice(i, i + 50) });
}

/** This device's sync key for the signed-in account, if it has one. */
export async function syncKey(): Promise<SyncKey | undefined> {
  try {
    const { user } = await request<{ user: CloudUser | null }>("me");
    return user ? await stored<SyncKey>(`key:${user.id}`) : undefined;
  } catch { return undefined; }
}

/** Newest first; empty when signed out, without a sync key, or offline. */
export async function list(path: string, limit = 25): Promise<CloudVersion[]> {
  const key = await syncKey();
  if (!key) return [];
  try {
    const { versions } = await request<{ versions: { id: string; createdAt: string }[] }>(`file-history?tag=${await pathTag(path, key)}`);
    const opened = await Promise.all(versions.slice(0, limit).map(async ({ id, createdAt }) => {
      try {
        const { sealed } = await request<{ sealed: string }>(`file-history/${id}`);
        const version = await open<Sealed>(JSON.parse(sealed) as Envelope, key);
        // A version sealed for another path under the same tag cannot happen, but is never shown.
        if (version.path !== path) return null;
        return { id, at: version.at || createdAt, device: version.device, source: version.source, ...(version.language ? { language: version.language } : {}) };
      } catch { return null; }
    }));
    return opened.filter((version): version is CloudVersion => !!version);
  } catch { return []; }
}
