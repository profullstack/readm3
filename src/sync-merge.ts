/**
 * Three-way merge of a synced workspace, per document, so every signed-in device can
 * sync on its own without one device's copy replacing another's.
 *
 *  - `base` is what this device last agreed with the account: a digest per path.
 *  - A document changed only on one side takes that side; changed on both, the account
 *    copy keeps the path and this device's copy is kept beside it as a conflict file.
 *  - A deletion carries over unless the other side edited the document meanwhile.
 *  - A device that has never synced (no base) never deletes or overwrites anything:
 *    the account's documents win their paths, and the device's own documents join them,
 *    except the untouched starter documents every new device begins with.
 *
 * Pure (no DOM, no network) so it is tested like the renderer.
 */
import type { SyncedWorkspace, WorkspaceDocument } from "./sync-schema.ts";

export type Digest = (text: string) => string;

/** FNV-1a over the text and the language: cheap, and only ever compared on one account. */
export const digestDocument = (doc: Pick<WorkspaceDocument, "source" | "language">): string => {
  let hash = 0x811c9dc5;
  const text = `${doc.language ?? ""}\0${doc.source}`;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length.toString(36)}:${(hash >>> 0).toString(36)}`;
};

export const digests = (workspace: SyncedWorkspace | undefined): Record<string, string> =>
  Object.fromEntries((workspace?.documents ?? []).map((doc) => [doc.path, digestDocument(doc)]));

export interface MergeResult {
  workspace: SyncedWorkspace;
  /** Paths saved beside the account copy because both sides changed them. */
  conflicts: string[];
  /** The merge differs from what the account holds, so this device must upload it. */
  upload: boolean;
  /** The merge differs from what this device holds, so it must be applied here. */
  download: boolean;
}

function conflictPath(path: string, label: string, taken: Set<string>): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const cut = dot > slash + 1 ? dot : path.length;
  for (let n = 1; ; n++) {
    const candidate = `${path.slice(0, cut)} (${label}${n > 1 ? ` ${n}` : ""})${path.slice(cut)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function mergeWorkspaces(options: {
  local: SyncedWorkspace;
  remote: SyncedWorkspace | undefined;
  base: Record<string, string> | undefined;
  /** Starter documents (path → digest) that a fresh device holds and nobody wrote. */
  starter?: Record<string, string>;
  /** Names this device in conflict copies, e.g. "conflict desktop 2026-10-19". */
  conflictLabel?: string;
}): MergeResult {
  const { local, remote, base, starter = {}, conflictLabel = "conflict" } = options;
  const L = new Map(local.documents.map((doc) => [doc.path, doc]));
  const R = new Map((remote?.documents ?? []).map((doc) => [doc.path, doc]));
  const merged = new Map<string, WorkspaceDocument>();
  const conflicts: string[] = [];
  const isStarter = (doc: WorkspaceDocument) => starter[doc.path] === digestDocument(doc);

  for (const path of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(path), r = R.get(path);
    const ld = l && digestDocument(l), rd = r && digestDocument(r);
    if (!base) {
      // First sync on this device: nothing is deleted, the account wins shared paths.
      if (r) merged.set(path, r);
      if (l && !isStarter(l) && (!r || ld !== rd)) {
        if (!r) merged.set(path, l);
        else { const copy = conflictPath(path, conflictLabel, new Set([...L.keys(), ...R.keys(), ...merged.keys()])); merged.set(copy, { ...l, path: copy }); conflicts.push(copy); }
      }
      continue;
    }
    const bd = base[path];
    if (l && r) {
      if (ld === rd || ld === bd) merged.set(path, r);
      else if (rd === bd) merged.set(path, l);
      else {
        merged.set(path, r);
        const copy = conflictPath(path, conflictLabel, new Set([...L.keys(), ...R.keys(), ...merged.keys()]));
        merged.set(copy, { ...l, path: copy });
        conflicts.push(copy);
      }
    } else if (l) {
      // Gone from the account: deleted elsewhere, unless it is new here or edited here since.
      if (bd === undefined || ld !== bd) merged.set(path, l);
    } else if (r) {
      // Gone from this device: deleted here, unless it is new there or edited there since.
      if (bd === undefined || rd !== bd) merged.set(path, r);
    }
  }

  const documents = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  // A workspace never syncs empty; the schema needs one document and an active path.
  if (!documents.length) documents.push(...local.documents);
  const name = remote && (!base ? true : local.name === remote.name) ? remote.name : local.name;
  const active = merged.has(local.active) ? local.active : remote && merged.has(remote.active) ? remote.active : documents[0]!.path;
  const workspace: SyncedWorkspace = { name, active, documents };
  const same = (a: SyncedWorkspace | undefined) => !!a && a.name === workspace.name
    && a.documents.length === documents.length
    && documents.every((doc) => { const other = a.documents.find((d) => d.path === doc.path); return !!other && digestDocument(other) === digestDocument(doc); });
  return { workspace, conflicts, upload: !same(remote), download: !same(local) };
}
