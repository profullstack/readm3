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
 *
 * End to end encrypted (src/sync-crypto.ts): what is uploaded is one sealed, compressed
 * blob, keyed by the person's sync passphrase, which never leaves the device. The derived
 * key is kept in this device's IndexedDB (non-extractable), so the passphrase is typed
 * once per device. An account still holding a readable copy is sealed on the first pass.
 */
import { ApiError, modal, request, type CloudUser } from "./cloud.ts";
import { deriveKey, MIN_PASSPHRASE, newKdf, open, seal, SEALED_FILE, WrongPassphrase, type Envelope, type SyncKey } from "../src/sync-crypto.ts";
import { digestDocument, digests, mergeWorkspaces } from "../src/sync-merge.ts";
import { isSealed, validateSyncFiles, type ReaderSettings, type SyncedWorkspace } from "../src/sync-schema.ts";
import { store, stored } from "./sync.ts";
import * as blobs from "./blobs.ts";
import { formatStorage, newBlobRef, SNAPSHOT_INLINE_BYTES, type BlobRef } from "../src/blob-store.ts";

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
type State = { revision: number; base: Record<string, string>; settings: string; spills?: Record<string, BlobRef> };
type Latest = { revision: number; snapshot: { version: number; files: Record<string, { content: string }> } };

let host: AutoSyncHost | undefined;
let starter: Record<string, string> | undefined;
let running = false;
let again = false;
let known = -1;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Re-seal under a new passphrase on the next pass, even when nothing else changed. */
let rekey = false;
let prompted = false;

/** Sync waits for the person (a passphrase); not an error. */
class Paused extends Error {}
type Files = Record<string, { content: string }>;
const envelopeOf = (files: Files): Envelope => JSON.parse(files[SEALED_FILE]!.content) as Envelope;
const keyName = (userId: string) => `key:${userId}`;

/**
 * Ask for the sync passphrase: `create` when the account has no encrypted copy yet (or
 * the person is changing it), `unlock` to open the one it has. Resolves once a key that
 * works is stored on this device.
 */
export function askPassphrase(mode: "create" | "unlock", userId: string, envelope?: Envelope): Promise<boolean> {
  return new Promise((resolve) => {
    const box = modal(mode === "create" ? "Encrypt your synced files" : "Unlock your synced files");
    const intro = document.createElement("p");
    intro.textContent = mode === "create"
      ? "Choose a sync passphrase. Your files are encrypted on this device before they are uploaded, so readm3.com stores only scrambled data. Nobody, including us, can read them or reset this passphrase. Save it in your password manager; you type it once on each device."
      : "Your synced files are end-to-end encrypted. Enter your sync passphrase to sync this device. You can paste it from your password manager.";
    const form = document.createElement("form");
    const field = (label: string, auto: AutoFill) => {
      const wrap = document.createElement("label");
      const input = document.createElement("input");
      input.type = "password"; input.autocomplete = auto; input.required = true; input.minLength = mode === "create" ? MIN_PASSPHRASE : 1;
      wrap.append(label, input);
      form.append(wrap);
      return input;
    };
    // Lets a password manager file the passphrase under a recognisable name.
    const user = document.createElement("input");
    user.type = "text"; user.autocomplete = "username"; user.value = "readm3 sync passphrase"; user.readOnly = true;
    user.style.cssText = "position:absolute;opacity:0;pointer-events:none;height:0;width:0";
    form.append(user);
    const pass = field("Sync passphrase", mode === "create" ? "new-password" : "current-password");
    const confirm = mode === "create" ? field("Type it again", "new-password") : undefined;
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    const submit = document.createElement("button");
    submit.type = "submit"; submit.className = "primary";
    submit.textContent = mode === "create" ? "Encrypt and sync" : "Unlock";
    const later = document.createElement("button");
    later.type = "button"; later.textContent = "Not now";
    form.append(error, submit, later);
    box.body.append(intro, form);
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; box.close(); resolve(ok); };
    later.onclick = () => finish(false);
    form.onsubmit = async (event) => {
      event.preventDefault();
      error.textContent = "";
      if (mode === "create" && pass.value.length < MIN_PASSPHRASE) { error.textContent = `Use at least ${MIN_PASSPHRASE} characters.`; return; }
      if (confirm && confirm.value !== pass.value) { error.textContent = "The two passphrases differ."; return; }
      submit.disabled = true;
      submit.textContent = "Working…";
      try {
        const key = await deriveKey(pass.value, envelope?.kdf ?? newKdf());
        if (envelope) await open(envelope, key);
        await store(keyName(userId), key);
        if (mode === "create") rekey = true;
        finish(true);
        void syncNow();
      } catch (problem) {
        error.textContent = problem instanceof WrongPassphrase ? "That passphrase does not open your synced files." : "Could not set up encryption on this device.";
        submit.disabled = false;
        submit.textContent = mode === "create" ? "Encrypt and sync" : "Unlock";
      }
    };
    queueMicrotask(() => pass.focus());
  });
}

/** Forget this device's key: the next pass asks for the passphrase again. */
export async function forgetPassphrase(userId: string) { await store(keyName(userId), undefined); known = -1; }

/** The key for this account on this device, or a prompt (once per page) and a pause. */
async function keyFor(user: CloudUser, files: Files | undefined): Promise<SyncKey> {
  const sealed = files && isSealed(files) ? envelopeOf(files) : undefined;
  const key = await stored<SyncKey>(keyName(user.id));
  // A different salt means the passphrase was changed on another device.
  if (key && (!sealed || key.kdf.salt === sealed.kdf.salt)) return key;
  if (key) await forgetPassphrase(user.id);
  if (!prompted) { prompted = true; void askPassphrase(sealed ? "unlock" : "create", user.id, sealed); }
  throw new Paused(sealed ? "Sync paused · enter your sync passphrase (Sync)" : "Sync paused · set a sync passphrase to encrypt your files (Sync)");
}

const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const time = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const sameDigests = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((path) => a[path] === b[path]);

async function starterDigests(): Promise<Record<string, string>> {
  if (starter) return starter;
  try { starter = digests(await (await fetch(host!.seedUrl)).json() as SyncedWorkspace); } catch { starter = {}; }
  return starter;
}

/** An upload this recent may belong to another device's save in flight; it is not collected yet. */
const GC_GRACE_MS = 3600_000;

/**
 * The workspace as it is uploaded: every stored file on the account, and small text past
 * the snapshot's share spilled to stored files too (the largest first), so the sealed
 * snapshot stays small however many files there are. A spill keeps the text's digest,
 * so the merge sees the same document, and is reused while the text is unchanged.
 */
async function forUpload(workspace: SyncedWorkspace, remote: SyncedWorkspace | undefined, spills: Record<string, BlobRef>) {
  const account = await blobs.account();
  const complete = new Set(account.blobs.filter((blob) => blob.complete).map((blob) => blob.id));
  const known = new Map<string, BlobRef>(Object.entries(spills));
  for (const doc of remote?.documents ?? []) if (doc.blob?.digest) known.set(doc.blob.digest, doc.blob);
  const encoder = new TextEncoder();
  const inline = workspace.documents.filter((doc) => !doc.blob).map((doc) => ({ doc, size: encoder.encode(doc.source).length })).sort((a, b) => a.size - b.size);
  const spill = new Set<string>();
  let budget = SNAPSHOT_INLINE_BYTES;
  for (const { doc, size } of inline) { if (size <= budget) budget -= size; else spill.add(doc.path); }
  const nextSpills: Record<string, BlobRef> = {};
  const documents = [];
  for (const doc of workspace.documents) {
    if (doc.blob) {
      if (!complete.has(doc.blob.id)) {
        const kept = await blobs.local(doc.blob);
        // A file that is on neither side cannot be sent; its reference travels so it is not lost elsewhere.
        if (kept) { host?.status(`Uploading ${doc.path.split("/").at(-1)} (${formatStorage(doc.blob.size)})…`); await blobs.upload(doc.blob, kept); complete.add(doc.blob.id); }
      }
      documents.push(doc);
      continue;
    }
    if (!spill.has(doc.path)) { documents.push(doc); continue; }
    const digest = digestDocument(doc);
    let ref = known.get(digest);
    if (!ref || !complete.has(ref.id)) {
      ref = newBlobRef(encoder.encode(doc.source).length, digest);
      await blobs.upload(ref, new Blob([doc.source]));
      complete.add(ref.id);
    }
    nextSpills[digest] = ref;
    documents.push({ path: doc.path, source: "", ...(doc.language ? { language: doc.language } : {}), blob: ref });
  }
  return { workspace: { ...workspace, documents }, spills: nextSpills, account };
}

/** Deletes the account's stored files that the saved workspace no longer names. */
async function collect(workspace: SyncedWorkspace, account: blobs.StorageAccount) {
  const used = new Set(workspace.documents.flatMap((doc) => doc.blob ? [doc.blob.id] : []));
  const cutoff = Date.now() - GC_GRACE_MS;
  for (const blob of account.blobs) {
    if (used.has(blob.id) || Date.parse(blob.createdAt) > cutoff) continue;
    try { await blobs.remove(blob.id); } catch { /* The next save tries again. */ }
  }
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
    let files: Files | undefined;
    if (remote) {
      if (remote.snapshot.version !== 1) throw new Error("the account copy needs a newer readm3");
      validateSyncFiles(remote.snapshot.files);
      files = remote.snapshot.files;
    }
    const syncKey = await keyFor(user, files);
    if (files && isSealed(files)) {
      try { files = await open<Files>(envelopeOf(files), syncKey); }
      catch (error) {
        if (!(error instanceof WrongPassphrase)) throw error;
        await forgetPassphrase(user.id);
        prompted = false;
        return void await keyFor(user, remote!.snapshot.files);
      }
      validateSyncFiles(files);
    }
    if (files) {
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
    // A readable copy on the account is replaced by a sealed one at once (the server then deletes the readable revisions).
    const readableOnServer = !!remote && !isSealed(remote.snapshot.files);
    let spills = state?.spills ?? {};
    if (!(onlyStarter && !remote) && (merge.upload || (settingsChanged && remote) || readableOnServer || rekey)) {
      const outgoing = await forUpload(merge.workspace, remoteWorkspace, spills);
      spills = outgoing.spills;
      const plain = { "settings.json": { content: serialize(settings) }, "workspace.json": { content: serialize(outgoing.workspace) } };
      validateSyncFiles(plain);
      const sealed = { [SEALED_FILE]: { content: JSON.stringify(await seal(plain, syncKey)) } };
      try {
        const saved = await request<{ revision: number; userId: string }>("settings", "PUT", {
          accountId: user.id, snapshot: { version: 1, host: h.device, app: h.app, files: sealed }, ifRevision: revision,
        });
        rekey = false;
        if (saved.userId !== user.id) throw new Error("your account changed");
        revision = saved.revision;
        void collect(outgoing.workspace, outgoing.account);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) continue; // Another device saved first.
        throw error;
      }
    }
    // Edits made while this pass ran are not overwritten: the next pass merges them.
    if (!sameDigests(digests(h.read()), localDigests)) { again = true; return; }
    if (merge.download || serialize(settings) !== localSettings) await h.apply(merge.workspace, settings);
    await store(key, { revision, base: digests(merge.workspace), settings: serialize(settings), spills } satisfies State);
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
    host.status(error instanceof Paused ? error.message : `Sync paused: ${error instanceof Error ? error.message : "unable to reach readm3.com"}`);
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
