import { readKey, writeKey } from "./workspace.ts";

/**
 * A rolling history of each file on this device: a snapshot whenever the file is
 * opened from disk, saved, or changes on disk underneath the editor (a generated
 * file being regenerated, say). The newest 50 versions are kept, and no more than
 * 8 MB of them per file; the oldest go first. Nothing here leaves the device except
 * the two versions sent when someone asks for an AI summary.
 */
export type Reason = "opened" | "saved" | "changed on disk" | "restored";
export interface Summary { text: string; costMicros: number; arm: string; at: string; }
export interface Snapshot { id: string; at: string; reason: Reason; source: string; summary?: Summary; }

export const MAX_SNAPSHOTS = 50;
export const MAX_BYTES = 8 * 1024 * 1024;
const key = (path: string) => `history:${path}`;

/** Newest first. Empty when the file has no history or storage is unavailable. */
export async function list(path: string): Promise<Snapshot[]> {
  try { return (await readKey<Snapshot[]>(key(path))) ?? []; } catch { return []; }
}

/** Keeps the newest versions within both limits. Exported for tests. */
export function trim(snapshots: Snapshot[]): Snapshot[] {
  const kept: Snapshot[] = [];
  let bytes = 0;
  for (const snapshot of snapshots.slice(0, MAX_SNAPSHOTS)) {
    bytes += snapshot.source.length;
    if (kept.length && bytes > MAX_BYTES) break;
    kept.push(snapshot);
  }
  return kept;
}

/** Records a version unless it is the same text as the newest one; returns it if recorded. */
export async function record(path: string, source: string, reason: Reason): Promise<Snapshot | null> {
  const snapshots = await list(path);
  if (snapshots[0]?.source === source) return null;
  const snapshot: Snapshot = { id: crypto.randomUUID(), at: new Date().toISOString(), reason, source };
  try { await writeKey(key(path), trim([snapshot, ...snapshots])); } catch { return null; }
  return snapshot;
}

export async function setSummary(path: string, id: string, summary: Summary): Promise<void> {
  const snapshots = await list(path);
  const target = snapshots.find((snapshot) => snapshot.id === id);
  if (!target) return;
  target.summary = summary;
  await writeKey(key(path), snapshots);
}
