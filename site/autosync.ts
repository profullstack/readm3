/**
 * Automatic sync: every signed-in device (browser tab, installed app, desktop app) keeps
 * the workspace and reader settings in step with the account, with no button. On by
 * default; "Sync automatically" in the Sync dialog turns it off for this device.
 *
 * Each pass loads the account copy, merges per document against what this device last
 * agreed with (src/sync-merge.ts), uploads the merge with the revision it started from
 * (a 409 means another device saved first: start over), and applies the merge here.
 * A device that has never synced loads first and never uploads its starter files.
 * Between passes it only asks for the latest revision number, not the whole workspace.
 */
import { ApiError, request, type CloudUser } from "./cloud.ts";
import { digestDocument, digests, mergeWorkspaces } from "../src/sync-merge.ts";
import { validateSyncFiles, type ReaderSettings, type SyncedWorkspace } from "../src/sync-schema.ts";
import { store, stored } from "./sync.ts";

const OFF = "readm3:autosync";
export const autoSyncEnabled = (): boolean => { try { return localStorage.getItem(OFF) !== "off"; } catch { return true; } };
export function setAutoSync(on: boolean) { try { localStorage.setItem(OFF, on ? "on" : "off"); } catch { /* This device only. */ } if (on) void syncNow(); else host?.status("Sync is off on this device"); }

export interface AutoSyncHost {
  read(): SyncedWorkspace;
  settings(): ReaderSettings;
  apply(workspace: SyncedWorkspace, settings: ReaderSettings | undefined): Promise<void>;
  status(text: string): void;
  /** Names this device in conflict copies: "desktop", "browser". */
  device: string;
  seedUrl: string;
  app: string;
}
type State = { revision: number; base: Record<string, string>; settings: string };
type Latest = { revision: number; snapshot: { version: number; files: Record<string, { content: string }> } };

let host: AutoSyncHost | undefined;
let starter: Record<string, string> | undefined;
let running = false;
let again = false;
let known = -1;
let timer: ReturnType<typeof setTimeout> | undefined;

const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const time = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDigests = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((path) => a[path] === b[path]);

async function starterDigests(): Promise<Record<string, string>> {
  if (starter) return starter;
  try { starter = digests(await (await fetch(host!.seedUrl)).json() as SyncedWorkspace); } catch { starter = {}; }
  return starter;
}

async function latest(userId: string): Promise<Latest | undefined> {
  try { return await request<Latest>(`settings?accountId=${encodeURIComponent(userId)}`); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return undefined; throw error; }
}

async function pass(user: CloudUser) {
  const h = host!;
  const key = `auto:${user.id}`;
  const state = await stored<State>(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = await latest(user.id);
    let remoteWorkspace: SyncedWorkspace | undefined;
    let remoteSettings: ReaderSettings | undefined;
    if (remote) {
      if (remote.snapshot.version !== 1) throw new Error("the account copy needs a newer readm3");
      validateSyncFiles(remote.snapshot.files);
      const files = remote.snapshot.files;
      remoteWorkspace = files["workspace.json"] ? JSON.parse(files["workspace.json"].content) : undefined;
      remoteSettings = files["settings.json"] ? JSON.parse(files["settings.json"].content) : undefined;
    }
    const local = structuredClone(h.read());
    const localDigests = digests(local);
    const merge = mergeWorkspaces({
      local, remote: remoteWorkspace, base: state?.base, starter: await starterDigests(),
      conflictLabel: `${h.device} ${new Date().toISOString().slice(0, 10)}`,
    });
    // Settings: this device's choice wins only if it changed since the last sync.
    const localSettings = serialize(h.settings());
    const settings = !remoteSettings || (state && localSettings !== state.settings) ? h.settings() : remoteSettings;
    const settingsChanged = serialize(settings) !== (remoteSettings ? serialize(remoteSettings) : "");
    let revision = remote?.revision ?? 0;
    // An account with nothing in it is not filled with the starter documents.
    const onlyStarter = local.documents.every((doc) => (starter ?? {})[doc.path] === digestDocument(doc));
    if (!(onlyStarter && !remote) && (merge.upload || (settingsChanged && remote))) {
      const files = { "settings.json": { content: serialize(settings) }, "workspace.json": { content: serialize(merge.workspace) } };
      validateSyncFiles(files);
      try {
        const saved = await request<{ revision: number; userId: string }>("settings", "PUT", {
          accountId: user.id, snapshot: { version: 1, host: h.device, app: h.app, files }, ifRevision: revision,
        });
        if (saved.userId !== user.id) throw new Error("your account changed");
        revision = saved.revision;
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) continue; // Another device saved first.
        throw error;
      }
    }
    // Edits made while this pass ran are not overwritten: the next pass merges them.
    if (!sameDigests(digests(h.read()), localDigests)) { again = true; return; }
    if (merge.download || serialize(settings) !== localSettings) await h.apply(merge.workspace, settings);
    await store(key, { revision, base: digests(merge.workspace), settings: serialize(settings) } satisfies State);
    known = revision;
    h.status(merge.conflicts.length
      ? `Synced · ${merge.conflicts.length} conflict cop${merge.conflicts.length === 1 ? "y" : "ies"} kept`
      : `Synced to your account · ${time()}`);
    return;
  }
  throw new Error("other devices kept saving; trying again shortly");
}

/** One sync pass now (or right after the one running). */
export async function syncNow(): Promise<void> {
  if (!host || !autoSyncEnabled()) return;
  if (running) { again = true; return; }
  running = true;
  try {
    const { user } = await request<{ user: CloudUser | null }>("me");
    if (!user) { host.status("Sign in to sync across your devices"); return; }
    host.status("Syncing…");
    await pass(user);
  } catch (error) {
    host.status(`Sync paused: ${error instanceof Error ? error.message : "unable to reach readm3.com"}`);
  } finally {
    running = false;
    if (again) { again = false; schedule(1000); }
  }
}

/** After a local edit: wait for typing to settle, then sync. */
export function schedule(delay = 4000) {
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

/** Cheap check: only a new revision on the account starts a full pass. */
async function poll() {
  if (!host || !autoSyncEnabled() || document.hidden || running) return;
  try {
    const { revisions } = await request<{ revisions: { revision: number }[] }>("settings/revisions");
    if ((revisions[0]?.revision ?? 0) !== known) await syncNow();
  } catch { /* Signed out or offline: the next focus or edit tries again. */ }
}

export function startAutoSync(options: AutoSyncHost) {
  host = options;
  if (!autoSyncEnabled()) { host.status("Sync is off on this device"); return; }
  void syncNow();
  setInterval(() => void poll(), 30_000);
  window.addEventListener("focus", () => void poll());
  window.addEventListener("online", () => void syncNow());
}
