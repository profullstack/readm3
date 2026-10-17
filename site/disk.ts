import { accepts, MAX_FILES, readKey, writeKey } from "./workspace.ts";

/**
 * Files that came from disk and can go back to it, through the File System Access API
 * (Chrome, Edge, the installed app, the desktop build). A handle never enters the
 * workspace document, which syncs: it is kept per path on this device only, with a
 * hash of what was last read from or written to disk so an unsaved file can be marked.
 * Browsers without the API keep the old behaviour: files are copied in, Ctrl+S downloads.
 */
export interface DiskEntry { handle: FileSystemFileHandle; saved: number; }
export interface Picked { file: File; path: string; handle?: FileSystemFileHandle; }

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

export async function pickFolder(): Promise<{ name: string; files: Picked[] } | null> {
  let root: Directory;
  try { root = await picker().showDirectoryPicker({ id: "readm3", mode: "readwrite" }) as Directory; }
  catch (error) { if (cancelled(error)) return null; throw error; }
  const files: Picked[] = [];
  const walk = async (directory: Directory, prefix: string) => {
    for await (const entry of directory.values()) {
      if (files.length >= MAX_FILES) return;
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

export async function pickFiles(): Promise<Picked[] | null> {
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

/** A file the desktop app opened for the page: its path, its name and its bytes. */
export interface DesktopFile { path: string; name: string; data: Uint8Array; }
interface DesktopBridge {
  takeLaunchFiles(): Promise<DesktopFile[]>;
  onOpenFiles(callback: (files: DesktopFile[]) => void): void;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}
/** Present only inside the readm3 desktop app (desktop/preload.cjs). */
export const desktop = typeof window === "undefined" ? undefined : (window as unknown as { readm3Desktop?: DesktopBridge }).readm3Desktop;

/**
 * A desktop file as a file handle, so the rest of the editor treats it like one from a
 * picker. It lasts for the session: it cannot be stored, and that is fine, because the
 * desktop hands the file over again the next time it is opened.
 */
export function fromDesktop(files: DesktopFile[]): Picked[] {
  return files.map((entry) => {
    const handle = {
      kind: "file", name: entry.name,
      getFile: async () => new File([entry.data.buffer as ArrayBuffer], entry.name),
      createWritable: async () => {
        const parts: BlobPart[] = [];
        return { write: async (data: BlobPart) => { parts.push(data); }, close: async () => { await desktop!.writeFile(entry.path, new Uint8Array(await new Blob(parts).arrayBuffer())); } };
      },
    } as unknown as FileSystemFileHandle;
    return { file: new File([entry.data.buffer as ArrayBuffer], entry.name), path: entry.name, handle };
  });
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
  try { return await picker().showSaveFilePicker({ id: "readm3", suggestedName: name }); }
  catch (error) { if (cancelled(error)) return null; throw error; }
}

const KEY = "disk";
export async function loadEntries(): Promise<Map<string, DiskEntry>> {
  try { return new Map(Object.entries(await readKey<Record<string, DiskEntry>>(KEY) ?? {})); }
  catch { return new Map(); }
}
export async function storeEntries(entries: Map<string, DiskEntry>): Promise<void> {
  try { await writeKey(KEY, Object.fromEntries(entries)); } catch { /* Handles last for this session only. */ }
}
