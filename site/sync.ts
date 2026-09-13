import { modal, request, showError, type CloudUser } from "./cloud.ts";
import { SYNC_FILES, validateSyncFiles, type ReaderSettings, type SyncedWorkspace } from "../src/sync-schema.ts";

type Files = Record<string, { content: string }>;
type Marker = { revision: number; files: Record<string, string> };
type Latest = { revision: number; digest: string; userId: string; snapshot: { version: number; files: Files } };
function loadMarker(key: string): Marker | undefined {
  const saved = sessionStorage.getItem(`readm3:${key}`);
  if (!saved) return;
  const marker = JSON.parse(saved) as Marker;
  if (!Number.isSafeInteger(marker.revision) || !marker.files) throw new Error("Invalid sync state in this tab.");
  return marker;
}
function saveMarker(key: string, marker: Marker) { sessionStorage.setItem(`readm3:${key}`, JSON.stringify(marker)); }
export interface SyncWorkspace {
  read(): SyncedWorkspace;
  settings(): ReaderSettings;
  apply(workspace: SyncedWorkspace | undefined, settings: ReaderSettings | undefined): Promise<void>;
}
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const currentFiles = (workspace: SyncWorkspace): Files => ({ "settings.json": { content: serialize(workspace.settings()) }, "workspace.json": { content: serialize(workspace.read()) } });
const encode = new TextEncoder();
async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encode.encode(value)))].map((n) => n.toString(16).padStart(2, "0")).join("");
}
export async function digestFiles(files: Files) {
  return sha256(Object.keys(files).sort().map((path) => `${path}\0${encode.encode(files[path].content).length}\0${files[path].content}\0`).join(""));
}
async function fileDigests(files: Files) { return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([path, file]) => [path, await sha256(file.content)]))); }

let connection: Promise<IDBDatabase> | undefined;
async function database() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("readm3-sync", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Browser storage is blocked."));
  });
}
async function stored<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const query = db.transaction("state").objectStore("state").get(key);
    query.onsuccess = () => resolve(query.result);
    query.onerror = () => reject(query.error);
  });
}
async function store(key: string, value: unknown) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    transaction.objectStore("state").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function showSync(workspace: SyncWorkspace) {
  const box = modal("Sync your workspace");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Checking your account…";
  box.body.append(status);
  try {
    const { user } = await request<{ user: CloudUser | null }>("me");
    if (!user) {
      status.textContent = "Sign in to save your workspace and reader settings across devices.";
      const login = document.createElement("a");
      login.href = "/account?next=/viewer";
      login.textContent = "Sign in or create an account";
      box.body.append(login);
      return;
    }
    const key = `marker:${user.id}`;
    // Each tab retains the revision it actually loaded. A save in another tab
    // must not advance this tab's precondition and allow a stale overwrite.
    let marker = loadMarker(key);
    status.textContent = `Signed in as ${user.username}. ${marker ? `Last synced revision ${marker.revision}.` : "This browser has not synced this account yet."}`;
    const explanation = document.createElement("p");
    explanation.textContent = "Save uploads the Markdown workspace open here and your theme and flavor. Load brings back the account copy. Local edits are kept unless you choose to replace them; a backup is saved before replacement.";
    box.body.append(explanation);
    const controls = document.createElement("div");
    controls.className = "cloud-actions";
    box.body.append(controls);
    const forceLabel = document.createElement("label");
    const force = document.createElement("input");
    force.type = "checkbox";
    forceLabel.append(force, " Replace conflicting changes (keep a local backup)");
    box.body.append(forceLabel);
    const buttons: HTMLButtonElement[] = [];
    const button = (label: string, action: () => Promise<void>) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = async () => {
        buttons.forEach((button) => button.disabled = true);
        try {
          const session = await request<{ user: CloudUser | null }>("me");
          if (session.user?.id !== user.id) throw new Error("Your account changed. Close this dialog and open Sync again.");
          marker = loadMarker(key);
          await action();
        } catch (error) { showError(status, error); }
        finally { buttons.forEach((button) => button.disabled = false); }
      };
      buttons.push(b); controls.append(b);
    };
    button("Save to account", async () => {
      const files = currentFiles(workspace);
      validateSyncFiles(files);
      const result = await request<{ revision: number; userId: string }>("settings", "PUT", { accountId: user.id, snapshot: { version: 1, host: "browser", app: "readm3 0.5.0", files }, ifRevision: force.checked ? null : marker?.revision ?? 0 });
      if (result.userId !== user.id) throw new Error("Your account changed while saving. Reopen Sync.");
      marker = { revision: result.revision, files: await fileDigests(files) };
      saveMarker(key, marker);
      status.textContent = `Saved revision ${result.revision} to your account.`;
    });
    button("Load from account", async () => {
      const before = currentFiles(workspace);
      const latest = await request<Latest>(`settings?accountId=${encodeURIComponent(user.id)}`);
      if (latest.userId !== user.id) throw new Error("Your account changed while loading. Reopen Sync.");
      if (latest.snapshot.version !== 1) throw new Error("This snapshot needs a newer readm3 version.");
      validateSyncFiles(latest.snapshot.files);
      if (await digestFiles(latest.snapshot.files) !== latest.digest) throw new Error("Snapshot checksum mismatch.");
      const baseline = await fileDigests(before);
      const incoming = latest.snapshot.files;
      const changed = SYNC_FILES.filter((path) => incoming[path] && incoming[path].content !== before[path].content);
      const localChanges = changed.filter((path) => !marker || marker.files[path] !== baseline[path]);
      if (localChanges.length && !force.checked) throw new Error("This browser has local changes. Save them first, or choose Replace conflicting changes to load with a backup.");
      if (serialize(currentFiles(workspace)) !== serialize(before)) throw new Error("Your workspace changed while loading. Try again.");
      if (changed.length) await store(`backup:${user.id}:${Date.now()}:${crypto.randomUUID()}`, { files: before, savedAt: new Date().toISOString() });
      if (serialize(currentFiles(workspace)) !== serialize(before)) throw new Error("Your workspace changed while loading. Try again.");
      await workspace.apply(incoming["workspace.json"] ? JSON.parse(incoming["workspace.json"].content) : undefined, incoming["settings.json"] ? JSON.parse(incoming["settings.json"].content) : undefined);
      marker = { revision: latest.revision, files: await fileDigests(currentFiles(workspace)) };
      saveMarker(key, marker);
      status.textContent = `Loaded revision ${latest.revision}.${changed.length ? " Your previous workspace is in Local backups." : ""}`;
    });
    button("Saved revisions", async () => {
      const result = await request<{ revisions: { revision: number; savedAt: string; host: string }[] }>(`settings/revisions?accountId=${encodeURIComponent(user.id)}`);
      status.textContent = result.revisions.length ? result.revisions.map((r) => `Revision ${r.revision} · ${r.host} · ${new Date(r.savedAt).toLocaleString()}`).join("\n") : "Nothing saved to this account yet.";
      status.style.whiteSpace = "pre-line";
    });
    button("Local backups", async () => {
      const db = await database();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const query = db.transaction("state").objectStore("state").getAllKeys();
        query.onsuccess = () => resolve(query.result);
        query.onerror = () => reject(query.error);
      });
      const backups = keys.filter((key) => String(key).startsWith(`backup:${user.id}:`));
      const list = modal("Local sync backups");
      if (!backups.length) list.body.textContent = "No workspace has been replaced in this browser.";
      for (const key of backups.reverse()) {
        const value = await stored<{ files: Files; savedAt: string }>(String(key));
        if (!value) continue;
        const download = document.createElement("button");
        download.textContent = `Download backup · ${new Date(value.savedAt).toLocaleString()}`;
        download.onclick = () => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(value.files, null, 2)], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url; link.download = `readm3-backup-${value.savedAt.replace(/:/g, "-")}.json`; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        list.body.append(download);
        const restore = document.createElement("button");
        restore.textContent = "Restore this backup";
        restore.onclick = async () => {
          restore.disabled = true;
          try {
            validateSyncFiles(value.files);
            await store(`backup:${user.id}:${Date.now()}:${crypto.randomUUID()}`, { files: currentFiles(workspace), savedAt: new Date().toISOString() });
            await workspace.apply(value.files["workspace.json"] ? JSON.parse(value.files["workspace.json"].content) : undefined, value.files["settings.json"] ? JSON.parse(value.files["settings.json"].content) : undefined);
            status.textContent = "Restored the local backup. Save to account when you are ready.";
            list.close();
          } catch (error) { showError(status, error); }
          finally { restore.disabled = false; }
        };
        list.body.append(restore);
      }
    });
  } catch (error) { showError(status, error); }
}
