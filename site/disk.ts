import { accepts, readKey, writeKey } from "./workspace.ts";

/**
 * Files that came from disk and can go back to it, through the File System Access API
 * (Chrome, Edge, the installed app, the desktop build). A handle never enters the
 * workspace document, which syncs: it is kept per path on this device only, with a
 * hash of what was last read from or written to disk so an unsaved file can be marked.
 * Browsers without the API keep the old behaviour: files are copied in, Ctrl+S downloads.
 */
export interface DiskEntry { handle: FileSystemFileHandle; saved: number; }
/**
 * `onDisk`: opened by the desktop app, so the editor reads it from disk rather than keeping
 * a copy. A large one comes as its first 64 KB, enough to tell what it is, with `size`
 * saying how large the whole file is.
 */
export interface Picked { file: File; path: string; handle?: FileSystemFileHandle; size?: number; onDisk?: boolean; }
export type Progress = (done: number, total: number) => void;

/** The parts of the API that TypeScript's DOM library does not describe yet. */
interface PickerWindow {
  showDirectoryPicker(options?: { id?: string; mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker(options?: { id?: string; multiple?: boolean }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: { id?: string; suggestedName?: string }): Promise<FileSystemFileHandle>;
}
interface Permissioned { queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>; requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>; }
type Directory = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
const picker = () => window as unknown as PickerWindow;

export const supported = (): boolean => typeof window !== "undefined" && "showDirectoryPicker" in window && "showSaveFilePicker" in window;

/** A cheap fingerprint of a file's text, enough to tell whether it changed since it was saved. */
export function fingerprint(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** null when the person closes the picker, which is not an error. */
const cancelled = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export async function pickFolder(onProgress?: Progress): Promise<{ name: string; files: Picked[] } | null> {
  // The desktop app opens folders with the system dialog and lists them itself (desktop/main.cjs).
  if (desktop?.pick) {
    const files = await desktop.pick(true);
    if (!files) return null;
    return { name: files.find((file) => file.relative)?.relative!.split("/")[0] ?? "Your workspace", files: await fromDesktop(files, onProgress) };
  }
  let root: Directory;
  try { root = await picker().showDirectoryPicker({ id: "readm3", mode: "readwrite" }) as Directory; }
  catch (error) { if (cancelled(error)) return null; throw error; }
  const files: Picked[] = [];
  const walk = async (directory: Directory, prefix: string) => {
    // No count here: the editor applies the limits, which depend on being signed in.
    for await (const entry of directory.values()) {
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "directory") { if (accepts(`${path}/x`)) await walk(entry as Directory, path); }
      else if (accepts(path)) {
        const handle = entry as FileSystemFileHandle;
        files.push({ file: await handle.getFile(), path, handle });
      }
    }
  };
  await walk(root, root.name);
  return { name: root.name, files };
}

export async function pickFiles(onProgress?: Progress): Promise<Picked[] | null> {
  if (desktop?.pick) {
    const files = await desktop.pick(false);
    return files && fromDesktop(files, onProgress);
  }
  let handles: FileSystemFileHandle[];
  try { handles = await picker().showOpenFilePicker({ id: "readm3", multiple: true }); }
  catch (error) { if (cancelled(error)) return null; throw error; }
  return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), path: handle.name, handle })));
}

/** Files handed over by the operating system: "Open with readm3" on an installed app. */
export async function launched(handles: readonly FileSystemHandle[]): Promise<Picked[]> {
  const files = handles.filter((handle): handle is FileSystemFileHandle => handle.kind === "file");
  return Promise.all(files.map(async (handle) => ({ file: await handle.getFile(), path: handle.name, handle })));
}

/**
 * A file the desktop app opened for the page: its path, its name and its size; `relative`
 * when it came in a folder. The page reads the bytes (read-file, read-range). Builds before
 * 0.22.0 sent the bytes of files up to 4 MB along (`data`).
 */
export interface DesktopFile { path: string; name: string; relative?: string; size?: number; data?: Uint8Array; }
interface DesktopBridge {
  takeLaunchFiles(): Promise<DesktopFile[]>;
  onOpenFiles(callback: (files: DesktopFile[]) => void): void;
  /** Absent in desktop builds before 0.13.0, which only had the bytes from launch. */
  readFile?(path: string): Promise<{ data: Uint8Array; modified: number }>;
  readRange?(path: string, start: number, end: number): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Absent in desktop builds before 0.21.0, which used the page's pickers. */
  pick?(folder: boolean): Promise<DesktopFile[] | null>;
  saveAs?(name: string): Promise<{ path: string; name: string } | null>;
  /** Absent in desktop builds before 0.18.0: a large file's size and time without reading it. */
  stat?(path: string): Promise<{ size: number; modified: number }>;
  /** Absent in desktop builds before 0.19.0: which files opened in an earlier run are still there. */
  reopen?(paths: string[]): Promise<DesktopFile[]>;
}
/** Present only inside the readm3 desktop app (desktop/preload.cjs). */
export const desktop = typeof window === "undefined" ? undefined : (window as unknown as { readm3Desktop?: DesktopBridge }).readm3Desktop;

/**
 * A desktop file as a file handle, so the rest of the editor treats it like one from a
 * picker. It lasts for the session: it cannot be stored, and that is fine, because the
 * desktop hands the file over again the next time it is opened.
 */
export async function fromDesktop(files: DesktopFile[], onProgress?: Progress): Promise<Picked[]> {
  const picked: Picked[] = [];
  for (const [i, entry] of files.entries()) {
    // A large file from a desktop build without ranges cannot be read; it is left out.
    if (!entry.data && !desktop!.readRange) continue;
    const handle = desktopHandle(entry);
    try {
      let file: File;
      if (entry.data) file = new File([entry.data.buffer as ArrayBuffer], entry.name);
      // Past 4 MB only the start is read now; the rest stays on disk until it is opened.
      else if (entry.size! > LARGE) file = new File([await desktop!.readRange!(entry.path, 0, SAMPLE) as BlobPart], entry.name);
      else file = await handle.getFile();
      picked.push({ file, path: entry.relative ?? entry.name, handle, size: entry.size ?? file.size, onDisk: true });
    } catch { /* Unreadable now (moved, permissions): the rest still opens. */ }
    if (onProgress && (i % 50 === 49 || i === files.length - 1)) onProgress(i + 1, files.length);
  }
  return picked;
}

const LARGE = 4 * 1024 * 1024;
const SAMPLE = 64 * 1024;
const RANGE = 8 * 1024 * 1024;
/** A large file, read range by range into Blob parts, which the browser keeps on disk. */
async function whole(entry: DesktopFile): Promise<File> {
  const parts: Blob[] = [];
  for (let start = 0; start < entry.size!; start += RANGE)
    parts.push(new Blob([await desktop!.readRange!(entry.path, start, Math.min(entry.size!, start + RANGE)) as BlobPart]));
  return new File(parts, entry.name);
}

/** A handle over a path the desktop app may read and write; a Save As path has no size or bytes yet. */
function desktopHandle(entry: DesktopFile): FileSystemFileHandle {
  return {
    kind: "file", name: entry.name,
    // Read from disk each time, so the editor sees a file change under it and a save is not undone.
    getFile: async () => {
      // The file may have grown or shrunk since it was opened.
      if (desktop!.stat) { try { entry.size = (await desktop!.stat(entry.path)).size; } catch { /* Read as before. */ } }
      // A large file is read a range at a time, never whole through one message.
      if (!entry.data && entry.size !== undefined && (entry.size > LARGE || !desktop!.readFile)) return whole(entry);
      if (!desktop!.readFile) return new File([entry.data!.buffer as ArrayBuffer], entry.name);
      const { data, modified } = await desktop!.readFile(entry.path);
      return new File([data.buffer as ArrayBuffer], entry.name, { lastModified: modified });
    },
    stat: desktop!.stat ? () => desktop!.stat!(entry.path) : undefined,
    desktopFile: entry,
    createWritable: async () => {
      const parts: BlobPart[] = [];
      return { write: async (data: BlobPart) => { parts.push(data); }, close: async () => { await desktop!.writeFile(entry.path, new Uint8Array(await new Blob(parts).arrayBuffer())); } };
    },
  } as unknown as FileSystemFileHandle;
}

/**
 * A file's size and time without reading it, or null where that would mean reading the
 * whole file (a large file in a desktop build before 0.18.0). A picker's File is lazy.
 */
export async function stat(handle: FileSystemFileHandle): Promise<{ size: number; modified: number } | null> {
  const desktopStat = (handle as FileSystemFileHandle & { stat?: () => Promise<{ size: number; modified: number }> }).stat;
  try {
    if (desktopStat) return await desktopStat();
    if (typeof FileSystemHandle !== "undefined" && handle instanceof FileSystemHandle) { const file = await handle.getFile(); return { size: file.size, modified: file.lastModified }; }
  } catch { /* Moved or no longer readable. */ }
  return null;
}

/** Writes the file, asking for write access first if this session has not been granted it. */
export async function write(handle: FileSystemFileHandle, data: string | Uint8Array): Promise<void> {
  const permissioned = handle as FileSystemFileHandle & Partial<Permissioned>;
  if (permissioned.queryPermission && await permissioned.queryPermission({ mode: "readwrite" }) !== "granted"
    && await permissioned.requestPermission!({ mode: "readwrite" }) !== "granted") {
    throw new Error("Write access to this file was not granted.");
  }
  const stream = await handle.createWritable();
  await stream.write(typeof data === "string" ? data : new Blob([data.buffer as ArrayBuffer]));
  await stream.close();
}

/** Save As: a new file chosen by the person, or null if they close the picker. */
export async function saveAs(name: string): Promise<FileSystemFileHandle | null> {
  if (desktop?.saveAs) {
    const chosen = await desktop.saveAs(name);
    return chosen && desktopHandle(chosen);
  }
  try { return await picker().showSaveFilePicker({ id: "readm3", suggestedName: name }); }
  catch (error) { if (cancelled(error)) return null; throw error; }
}

const KEY = "disk";
/**
 * A desktop file's path per workspace path, since its handle cannot be stored. After a
 * restart the desktop app (0.19.0 on) hands back the ones it opened before, so a file saved
 * in another editor while readm3 was closed is still read from disk, not from the old copy.
 */
const DESKTOP_KEY = "disk-desktop";
type KeptDesktopFile = { path: string; name: string; relative?: string; saved: number };
export async function loadEntries(): Promise<Map<string, DiskEntry>> {
  let entries: Map<string, DiskEntry>;
  try { entries = new Map(Object.entries(await readKey<Record<string, DiskEntry>>(KEY) ?? {})); }
  catch { entries = new Map(); }
  if (!desktop?.reopen) return entries;
  try {
    const kept = Object.entries(await readKey<Record<string, KeptDesktopFile>>(DESKTOP_KEY) ?? {});
    if (!kept.length) return entries;
    const found = new Map((await desktop.reopen(kept.map(([, file]) => file.path))).map((file) => [file.path, file]));
    for (const [path, file] of kept) {
      const now = found.get(file.path);
      if (now && !entries.has(path)) entries.set(path, { handle: desktopHandle({ path: file.path, name: file.name, relative: file.relative, size: now.size }), saved: file.saved });
    }
  } catch { /* An older desktop build, or an unreadable list: the copies stay as they are. */ }
  return entries;
}
/**
 * What each path last matched on disk, kept apart from the handles because a desktop
 * file's handle cannot be stored: after a restart this still tells an unedited copy
 * of a file (safe to refresh when it is opened again) from a draft.
 */
const SYNCED = "disk-synced";
let synced = new Map<string, number>();
export async function loadSynced(): Promise<Map<string, number>> {
  try { synced = new Map(Object.entries(await readKey<Record<string, number>>(SYNCED) ?? {})); } catch { /* Starts empty. */ }
  return synced;
}
export async function storeEntries(entries: Map<string, DiskEntry>): Promise<void> {
  // Only real handles can be stored; one desktop handle in the map would fail the whole write.
  const storable = [...entries].filter(([, entry]) => typeof FileSystemHandle !== "undefined" && entry.handle instanceof FileSystemHandle);
  try { await writeKey(KEY, Object.fromEntries(storable)); } catch { /* Handles last for this session only. */ }
  if (desktop) {
    const kept: Record<string, KeptDesktopFile> = {};
    for (const [path, entry] of entries) {
      const file = (entry.handle as FileSystemFileHandle & { desktopFile?: DesktopFile }).desktopFile;
      if (file) kept[path] = { path: file.path, name: file.name, relative: file.relative, saved: entry.saved };
    }
    try { await writeKey(DESKTOP_KEY, kept); } catch { /* As above. */ }
  }
  for (const [path, entry] of entries) synced.set(path, entry.saved);
  try { await writeKey(SYNCED, Object.fromEntries(synced)); } catch { /* As above. */ }
}
