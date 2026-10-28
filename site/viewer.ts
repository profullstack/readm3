import { action, request, type CloudDocument, type CloudUser } from "./cloud.ts";
import * as stored from "./blobs.ts";
import { refreshUsage, showUsage } from "./usage.ts";
import { formatStorage, INLINE_MAX_BYTES, MAX_ACCOUNT_FILES, MAX_BLOB_BYTES, newBlobRef } from "../src/blob-store.ts";
import { pasteDialog, publish, sharing, history as versionHistory } from "./sharing.ts";
import { showSync } from "./sync.ts";
import { askPassphrase, autoSyncEnabled, DEFAULT_SYNC_LIMIT_MB, forgetPassphrase, schedule as scheduleSync, setAutoSync, setSyncLimitMb, startAutoSync, syncLimitMb, syncNow } from "./autosync.ts";
import { renderMarkdown } from "../src/markdown.ts";
import type { Flavor } from "../src/flavors.ts";
import type { ReaderSettings } from "../src/sync-schema.ts";
import { toHtml } from "./html.ts";
import { renderCode, type CodeView } from "./code-view.ts";
import { renderTable } from "./table-view.ts";
import { TABLE_LANGUAGE } from "../src/csv.ts";
import type { SourceEditor } from "./code-editor.ts";
import * as disk from "./disk.ts";
import * as fileHistory from "./history.ts";
import { awaitTopUp, showHistory, showTopUp } from "./history-panel.ts";
import { showSummary } from "./summary-panel.ts";
import { showAsk } from "./ask-panel.ts";
import { openPalette, rank, type PaletteItem } from "./palette.ts";
import { binaryType, detectLanguage, languageForName, looksBinary, MARKDOWN, type BinaryType } from "../src/code.ts";
import { accepts, bytesOf, comparePaths, kindOf, MAX_FILE_BYTES, MAX_FILES, MAX_WORKSPACE_BYTES, persist, rawUrl, restore, toBase64, type Document, type Workspace } from "./workspace.ts";

/** The starter workspace's content-addressed URL, defined by the build. */
declare const __SEED_URL__: string;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reader = element("reader");
const content = element("document-content");
const editor = element("editor");
const filter = element<HTMLInputElement>("filter");
const fileList = element("file-list");
const theme = element<HTMLSelectElement>("theme");
const flavor = element<HTMLSelectElement>("flavor");
const saveStatus = element("save-status");
const filesInput = element<HTMLInputElement>("files-input");
const folderInput = element<HTMLInputElement>("folder-input");
const helpDialog = element<HTMLDialogElement>("help-dialog");
const urlDialog = element<HTMLDialogElement>("url-dialog");
const encoder = new TextEncoder();
let workspace: Workspace;
let cloudDocument: CloudDocument | null = null;
const shareToken = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{43})$/)?.[1];
const cloudId = new URLSearchParams(location.search).get("doc");
const pasteToken = location.pathname.match(/^\/p\/([A-Za-z0-9_-]{43})$/)?.[1];
interface PasteView { id: string; title: string; source: string; bytes: number; language: string; mime: string; createdAt: string; expiresAt: string; }
let pasteDocument: PasteView | null = null;
let cloudSaving = false;
const codeContent = element("code-content");
const mediaContent = element("media-content");
let codeView: CodeView | null = null;
/** CodeMirror, downloaded the first time anything is edited, then kept for every file. */
let sourceEditor: SourceEditor | null = null;
let editorLoading: Promise<SourceEditor> | undefined;
let editorPath = "";
/** Files opened from disk that Ctrl+S writes back to, by workspace path. */
let diskEntries = new Map<string, disk.DiskEntry>();
/**
 * A large file, PDF or image the desktop app opened is read from disk, never copied into
 * browser storage, and its reader lasts one session. After a restart (handles restored by
 * disk.loadEntries) or a sync, each one gets its reader back, so it opens, and sync can
 * upload it, without opening the folder again.
 */
function reattachDisk() {
  for (const doc of workspace.documents) {
    const entry = diskEntries.get(doc.path);
    if (doc.blob && entry) stored.fromDisk(doc.blob, () => entry.handle.getFile());
  }
}
/** Whether the file has a place on disk and differs from what was last read or written there. */
let diskSynced = new Map<string, number>();
/** A copy that holds nothing the disk lacks: the same text, or unedited since it was last read or saved. */
const matchesDisk = (doc: Document) => diskEntries.has(doc.path) ? !unsavedOnDisk(doc) : diskSynced.get(doc.path) === disk.fingerprint(doc.source);
const unsavedOnDisk = (doc: Document) => { const entry = diskEntries.get(doc.path); return !!entry && disk.fingerprint(doc.source) !== entry.saved; };
let mediaUrl: string | null = null;
/** What the active document is on screen: Markdown, code in some language, or a PDF or image. */
const kind = () => kindOf(current());
const isCode = () => kind().kind === "code";
const isBinary = () => kind().kind === "binary";
const isMarkdown = () => kind().kind === "markdown";
/** A CSV or TSV: text like code (edited the same way), but read as a table. */
const isTable = () => { const active = kind(); return active.kind === "code" && active.language.id === TABLE_LANGUAGE; };
/**
 * Signed in, the free tier has no file count and files up to 5 GB (src/blob-store.ts);
 * signed out, the workspace keeps its small local limits.
 */
let signedIn = false;
const ACCOUNT_LIMITS = "Sign in (free) for files up to 5 GB and up to 1,000,000 files.";
/** A stored file too large for the workspace (not a spilled small one): shown read-only. */
const isLarge = (doc = current()) => !!doc.blob && !doc.blob.digest;
const PREVIEW_BYTES = 1024 * 1024;
const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Shows the controls that make sense for the active document's kind. */
function applyKind() {
  const current = kind();
  element("flavor-label").hidden = current.kind !== "markdown";
  element("spoilers").hidden = current.kind !== "markdown";
  element("code-tools").hidden = current.kind !== "code" || isTable();
  element("copy").hidden = current.kind === "binary" || isLarge();
  // Any file can be summarized but text too large to open here (a large PDF or image still can).
  element("summarize").hidden = isLarge() && current.kind !== "binary";
  element("file-mark").textContent = current.kind === "markdown" ? "M↓" : current.kind === "code" ? current.language.extensions[0]!.toUpperCase()
    : current.binary.kind === "document" ? workspace.active.split(".").at(-1)!.toUpperCase() : current.binary.label.split(" ")[0]!.toUpperCase();
  element<HTMLButtonElement>("edit-mode").disabled = current.kind === "binary" || isLarge() || !!pasteDocument || (!!cloudDocument && !cloudDocument.canEdit);
  if (!cloudDocument && !pasteDocument) element("history").hidden = current.kind === "binary" || isLarge();
}

/** Whether the active file may be edited here: not a paste, not a view-only link, not a PDF, image or file over 4 MB. */
function canEdit(): boolean {
  return !pasteDocument && !isBinary() && !isLarge() && (!cloudDocument || cloudDocument.canEdit);
}

function cloudControls() {
  element("sync-workspace").hidden = !!cloudDocument;
  element("cloud-save").hidden = !cloudDocument?.canEdit;
  element("history").hidden = !cloudDocument?.canManage;
  element("share").hidden = !!cloudDocument && !cloudDocument.canManage;
  element<HTMLButtonElement>("edit-mode").disabled = !!cloudDocument && !cloudDocument.canEdit;
  if (cloudDocument) {
    element("file-pane").querySelectorAll<HTMLElement>(".open-actions,.extra-actions,.filter-label,.local-note").forEach(el => el.hidden = true);
    saveStatus.textContent = cloudDocument.pinned ? "Viewing a saved version" : cloudDocument.canEdit ? "Saved online · opens in read mode" : "View only";
  }
}

function adoptCloud(doc: CloudDocument) {
  cloudDocument = doc;
  workspace = { name: "Shared Markdown", active: doc.title, documents: [{ path: doc.title, source: doc.version.source }] };
  pendingSave = false;
  saveFailed = false;
  openDocument(doc.title);
  cloudControls();
}

/** A paste is somebody's private link: shown read-only, never written into this device's workspace. */
function adoptPaste(paste: PasteView) {
  pasteDocument = paste;
  // The server decided the language once, on create; the title alone might not carry it.
  workspace = { name: "Private link", active: paste.title, documents: [{ path: paste.title, source: paste.source, language: paste.language }] };
  pendingSave = false;
  saveFailed = false;
  openDocument(paste.title);
  element("sync-workspace").hidden = true;
  element("share").hidden = true;
  element("history").hidden = true;
  element("cloud-save").hidden = true;
  element("paste-delete").hidden = false;
  element("paste-share").hidden = true;
  element("new-paste").hidden = false;
  const raw = element<HTMLAnchorElement>("raw-link");
  raw.href = `/p/${pasteToken}/raw`;
  raw.hidden = false;
  element<HTMLButtonElement>("edit-mode").disabled = true;
  element("file-pane").querySelectorAll<HTMLElement>(".open-actions,.extra-actions,.filter-label,.local-note").forEach(el => el.hidden = true);
  saveStatus.textContent = `Private link · expires ${new Date(paste.expiresAt).toLocaleString()}`;
}

async function saveCloud() {
  if (!cloudDocument?.canEdit || !pendingSave || cloudSaving) return;
  cloudSaving = true;
  const button = element<HTMLButtonElement>("cloud-save");
  button.disabled = true;
  const savingRevision = revision;
  try {
    const body = { source: current().source, baseVersion: cloudDocument.currentVersion };
    const saved = shareToken ? await request<CloudDocument>(`shared/${shareToken}`, "PATCH", body)
      : await action<CloudDocument>("documents_update", { documentId: cloudDocument.id, ...body });
    cloudDocument = saved;
    if (revision === savingRevision) { pendingSave = false; saveFailed = false; saveStatus.textContent = "Version saved online"; }
    else saveStatus.textContent = "Unsaved changes · save a new version";
  } catch (error) {
    saveFailed = true;
    const message = error instanceof Error ? error.message : "Could not save this version.";
    saveStatus.textContent = "Not saved · your draft is still open";
    notice(message);
  } finally { cloudSaving = false; button.disabled = false; }
}
let editing = false;
let spoilers = false;
let pendingSave = false;
let revision = 0;
let saveTimer: ReturnType<typeof setTimeout>;
let noticeTimer: ReturnType<typeof setTimeout>;
let importBusy = false;
let saveFailed = false;
const collapsed = new Set<string>();
/**
 * A workspace of thousands of files (a whole ~/Desktop) shows its top folders with every
 * folder below them folded, except the way to the open file; a small one shows everything.
 */
function foldLarge(open: string) {
  collapsed.clear();
  if (workspace.documents.length <= 2000) return;
  const parts = open.split("/");
  const keep = new Set(parts.slice(0, -1).map((_, depth) => parts.slice(0, depth + 1).join("/")));
  for (const doc of workspace.documents) {
    const folders = doc.path.split("/");
    for (let depth = 1; depth < folders.length - 1; depth++) {
      const path = folders.slice(0, depth + 1).join("/");
      if (!keep.has(path)) collapsed.add(path);
    }
  }
}

function notice(message: string) {
  element("notice").textContent = message;
  element("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { element("notice").hidden = true; }, 6500);
}

function current(): Document { return workspace.documents.find((doc) => doc.path === workspace.active)!; }

async function save() {
  if (pasteDocument) return;
  if (cloudDocument) { await saveCloud(); return; }
  clearTimeout(saveTimer);
  const savingRevision = revision;
  pendingSave = true;
  try {
    await persist(workspace);
    if (revision === savingRevision) {
      // Every saved edit reaches the account a few seconds later, unless it came from sync.
      if (!applyingSync) scheduleSync();
      pendingSave = false;
      saveFailed = false;
      const unsaved = unsavedOnDisk(current());
      saveStatus.textContent = unsaved ? "Saved on this device · Ctrl+S writes it to disk" : diskEntries.has(current().path) ? "Saved to disk" : "Saved on this device";
      markUnsaved();
      updateUsage();
    }
  } catch {
    saveFailed = true;
    saveStatus.textContent = "Browser storage unavailable — download to keep your files";
  }
}

let applyingSync = false;
/** A workspace and settings from the account (Sync dialog or automatic sync) replace this device's. */
async function applySynced(incoming: Workspace | undefined, settings: ReaderSettings | undefined) {
  applyingSync = true;
  try {
    clearTimeout(saveTimer);
    if (incoming) {
      await persist(incoming);
      workspace = incoming;
      reattachDisk();
      filter.value = "";
      foldLarge(workspace.active);
    }
    if (settings?.theme && [...theme.options].some((option) => option.value === settings.theme)) theme.value = settings.theme;
    if (settings?.flavor) flavor.value = settings.flavor;
    storePreference("theme", theme.value);
    storePreference("flavor", flavor.value);
    document.documentElement.dataset.theme = theme.value;
    openDocument(workspace.documents.some((doc) => doc.path === workspace.active) ? workspace.active : workspace.documents[0]!.path, false);
    await save();
  } finally { applyingSync = false; }
}

function changed() {
  revision++;
  pendingSave = true;
  if (cloudDocument) { saveStatus.textContent = "Unsaved changes · save a new version"; return; }
  saveStatus.textContent = "Saving on this device…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 300);
}

/** The dot on the active file's row, tab and heading when its disk copy is behind. */
function markUnsaved() {
  const unsaved = unsavedOnDisk(current());
  element("document-name").classList.toggle("unsaved", unsaved);
  fileList.querySelector(`[aria-current="page"]`)?.classList.toggle("unsaved", unsaved);
  tabBar.querySelector(`[aria-selected="true"]`)?.classList.toggle("unsaved", unsaved);
}

/** Files opened this session, left to right, as in any editor; closing a tab keeps the file. */
const tabBar = element("tabs");
let tabs: string[] = [];
function renderTabs() {
  const local = !cloudDocument && !pasteDocument;
  tabs = tabs.filter((path) => workspace.documents.some((doc) => doc.path === path));
  if (local && !tabs.includes(workspace.active)) tabs.push(workspace.active);
  tabBar.hidden = !local;
  tabBar.replaceChildren(...tabs.map((path) => {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(path === workspace.active));
    tab.title = path;
    if (unsavedOnDisk(workspace.documents.find((doc) => doc.path === path)!)) tab.classList.add("unsaved");
    const open = document.createElement("button");
    open.className = "tab-name";
    open.textContent = path.split("/").at(-1)!;
    open.onclick = () => { if (path !== workspace.active) openDocument(path); };
    open.onauxclick = (event) => { if (event.button === 1) closeTab(path); };
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${path}`);
    close.disabled = tabs.length === 1;
    close.onclick = () => closeTab(path);
    tab.append(open, close);
    return tab;
  }));
  tabBar.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  // The active file goes with the tabs: the workspace record saves 300 ms later, and a
  // quick reload would otherwise reopen the old file and bring back a closed tab.
  if (local) storePreference("tabs", JSON.stringify({ tabs, active: workspace.active }));
}

function closeTab(path: string) {
  if (tabs.length < 2) return;
  const index = tabs.indexOf(path);
  tabs = tabs.filter((tab) => tab !== path);
  if (path === workspace.active) openDocument(tabs[Math.min(index, tabs.length - 1)]!);
  else renderTabs();
}

function showPalette(initial: string) {
  const files = (): PaletteItem[] => workspace.documents.map((doc) => ({ label: doc.path, detail: kindOf(doc).kind === "binary" ? "view" : undefined, run: () => openDocument(doc.path) }));
  openPalette({
    placeholder: "Go to file… (type > for commands)",
    initial,
    items: (query) => query.startsWith(">") ? rank(query.slice(1), commands()) : cloudDocument || pasteDocument ? [] : rank(query, files()),
  });
}

/** Everything the toolbar and keys do, by name, for the command palette. */
function commands(): PaletteItem[] {
  const command = (label: string, run: () => void, detail?: string): PaletteItem => ({ label, run, detail });
  const local = !cloudDocument && !pasteDocument;
  const withEditor = (run: (ready: SourceEditor) => void) => () => { if (!canEdit()) { notice("This file is read-only here."); return; } setMode(true); void loadEditor().then(run); };
  return [
    ...local ? [
      command("File: Open folder…", () => void openFromDisk(true)),
      command("File: Open files…", () => void openFromDisk(false)),
      command("File: Open URL…", () => urlDialog.showModal()),
      command("File: New note", () => element("new-file").click()),
      command("File: Save", () => void saveFile(), "Ctrl+S"),
      command("File: Save As…", () => void saveFile(true), "Ctrl+Shift+S"),
      command("File: Close tab", () => closeTab(workspace.active)),
      command("File: History", openHistory),
      command("Billing: Add funds", () => void showTopUp()),
      command("Billing: Usage and limits", showUsage),
      command("Sync: Sync this workspace to your account", () => element("sync-workspace").click()),
    ] : [],
    ...cloudDocument?.canEdit ? [command("File: Save version", () => void saveCloud(), "Ctrl+S")] : [],
    command("File: Download", download),
    ...isLarge() && !isBinary() ? [] : [command("File: Summarize with AI", summarize)],
    command("AI: Ask about these files", askAi),
    command("View: Read", () => setMode(false), "Esc"),
    ...canEdit() ? [command("View: Edit", () => setMode(true), "e")] : [],
    command("View: Toggle sidebar", () => document.body.classList.toggle("sidebar-hidden")),
    command("View: Toggle word wrap", () => element("wrap").click()),
    command("Edit: Find and replace", withEditor((ready) => ready.find()), "Ctrl+F"),
    command("Edit: Fold all", () => element("fold-all").click()),
    command("Edit: Unfold all", () => element("unfold-all").click()),
    ...[...theme.options].map((option) => command(`Theme: ${option.text}`, () => { theme.value = option.value; theme.dispatchEvent(new Event("change")); })),
    command("Help: Keyboard shortcuts", () => helpDialog.showModal(), "?"),
  ];
}

function setFilesOpen(open: boolean) {
  document.body.classList.toggle("files-open", open);
  element("toggle-files").setAttribute("aria-expanded", String(open));
}

function renderFiles(focusPath?: string) {
  const query = filter.value.toLocaleLowerCase().trim();
  const docs = workspace.documents.filter((doc) => doc.path.toLocaleLowerCase().includes(query));
  fileList.replaceChildren();
  const directories = new Set<string>();
  for (const doc of docs) {
    const parts = doc.path.split("/");
    let hidden = false;
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = parts.slice(0, depth + 1).join("/");
      if (!directories.has(path)) {
        directories.add(path);
        const row = fileRow(path, parts[depth], depth, true);
        row.setAttribute("aria-expanded", String(query !== "" || !collapsed.has(path)));
        fileList.append(row);
      }
      if (!query && collapsed.has(path)) { hidden = true; break; }
    }
    if (!hidden) fileList.append(fileRow(doc.path, parts.at(-1)!, parts.length - 1, false, doc));
  }
  if (!docs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-files";
    empty.textContent = "No files match your filter.";
    fileList.append(empty);
  }
  element("file-count").textContent = String(workspace.documents.length).padStart(2, "0");
  element("workspace-name").textContent = workspace.name;
  if (focusPath) Array.from(fileList.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.dataset.path === focusPath)?.focus();
}

function fileRow(path: string, name: string, depth: number, directory: boolean, doc?: Document) {
  const row = document.createElement("button");
  row.className = `file-row${directory ? " folder-row" : ""}`;
  row.dataset.path = path;
  row.style.paddingLeft = `${10 + depth * 15}px`;
  row.title = path;
  if (!directory && path === workspace.active) row.setAttribute("aria-current", "page");
  if (doc && unsavedOnDisk(doc)) row.classList.add("unsaved");
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  const fileKind = doc ? kindOf(doc) : null;
  icon.textContent = directory ? (filter.value || !collapsed.has(path) ? "▾" : "▸") : fileKind!.kind === "markdown" ? "M↓" : fileKind!.kind === "code" ? (fileKind!.language.id === TABLE_LANGUAGE ? "▦" : "{}") : "▣";
  const label = document.createElement("span");
  label.className = "row-name";
  label.textContent = name;
  row.append(icon, label);
  row.addEventListener("click", () => {
    if (directory) {
      if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
      renderFiles(path);
    } else openDocument(path);
  });
  return row;
}

function progress() {
  const pane = editing && sourceEditor ? sourceEditor.view.scrollDOM : reader;
  const range = pane.scrollHeight - pane.clientHeight;
  element("reading-progress").textContent = `${range <= 0 ? 100 : Math.round(pane.scrollTop / range * 100)}%`;
}

let previousRender = "";
/**
 * A PDF or image: the browser's own viewer on a blob URL, which is revoked when the next
 * one is made. An office document or e-book the browser cannot show gets a card instead.
 */
function renderMedia(mime: string, media: BinaryType["kind"], label: string) {
  const key = JSON.stringify(["media", workspace.active, current().source.length]);
  if (key === previousRender) return;
  previousRender = key;
  showMedia(new Blob([bytesOf(current()).buffer as ArrayBuffer], { type: mime }), media, label);
}

function showMedia(blob: Blob, media: BinaryType["kind"], label: string) {
  content.hidden = true;
  codeContent.hidden = true;
  mediaContent.hidden = false;
  codeView = null;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(blob);
  mediaContent.replaceChildren();
  if (media === "document") {
    const card = document.createElement("div");
    card.className = "media-card";
    const title = document.createElement("strong");
    title.textContent = current().path.split("/").at(-1)!;
    const summarizeButton = document.createElement("button");
    summarizeButton.type = "button";
    summarizeButton.className = "primary-action";
    summarizeButton.textContent = "Summarize with AI";
    summarizeButton.onclick = summarize;
    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "ghost";
    downloadButton.textContent = "Download";
    downloadButton.onclick = download;
    const line = document.createElement("p");
    line.textContent = `${label} · ${formatBytes(blob.size)}. Browsers cannot show this file; Summarize reads it for you, and Download opens it in your own app.`;
    card.append(title, line, summarizeButton, " ", downloadButton);
    mediaContent.append(card);
    return;
  }
  if (media === "image") {
    const image = document.createElement("img");
    image.src = mediaUrl;
    image.alt = current().path;
    mediaContent.append(image);
  } else {
    const embed = document.createElement("embed");
    embed.type = blob.type;
    embed.src = mediaUrl;
    embed.title = current().path;
    mediaContent.append(embed);
  }
  const note = document.createElement("p");
  note.className = "media-note";
  const link = document.createElement("a");
  link.href = mediaUrl;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open in a new tab";
  note.append(`${label}, shown by your browser. `, link, ", or Download to keep a copy.");
  mediaContent.append(note);
}

/**
 * A stored file (site/blobs.ts), read from this device or fetched from the account. A
 * small one spilled from the synced copy turns back into an ordinary file; a large one
 * is a PDF or image the browser shows, or text shown as a read-only first megabyte.
 */
function renderStored() {
  const doc = current();
  const ref = doc.blob!;
  const key = JSON.stringify(["stored", doc.path, ref.id]);
  if (key === previousRender) return;
  previousRender = key;
  const active = kind();
  content.hidden = true;
  mediaContent.hidden = true;
  codeContent.hidden = false;
  codeView = null;
  const status = document.createElement("p");
  status.className = "media-note";
  status.textContent = `Opening ${formatStorage(ref.size)}…`;
  codeContent.replaceChildren(status);
  const still = () => workspace.active === doc.path && current().blob?.id === ref.id;
  stored.bytes(ref, active.kind === "binary" ? active.binary.mime : "", (done) => { status.textContent = `Downloading from your account… ${Math.floor(done / Math.max(1, ref.size) * 100)}%`; })
    .then(async (blob) => {
      if (!still()) return;
      if (ref.digest) {
        doc.source = await blob.text();
        delete doc.blob;
        previousRender = "";
        applyKind();
        documentInfo();
        renderDocument();
        void save();
        return;
      }
      if (active.kind === "binary") { showMedia(blob, active.binary.kind, active.binary.label); return; }
      const pre = document.createElement("pre");
      pre.className = "large-preview";
      pre.textContent = await blob.slice(0, PREVIEW_BYTES).text();
      if (!still()) return;
      status.textContent = `This file is ${formatStorage(ref.size)}, too large to edit here. Showing the first 1 MB, read-only; Download gives the whole file.`;
      codeContent.replaceChildren(status, pre);
    })
    .catch((error) => {
      if (!still()) return;
      // Read from disk and gone from there (moved, renamed or deleted), with no copy on the account yet.
      status.textContent = diskSynced.has(doc.path) || diskEntries.has(doc.path)
        ? "This file was read from disk and is not there any more (moved, renamed or deleted). Open the folder that holds it now to read it again."
        : `${error instanceof Error ? error.message : "This file could not be opened."}${signedIn ? "" : " Sign in to fetch it from your account."}`;
      previousRender = "";
    });
}

function renderDocument() {
  if (!workspace || editing) return;
  if (current().blob) { renderStored(); progress(); return; }
  const active = kind();
  if (active.kind === "code") {
    const key = JSON.stringify(["code", workspace.active, current().source, active.language.id]);
    if (key !== previousRender && isTable()) {
      content.hidden = true;
      mediaContent.hidden = true;
      codeContent.hidden = false;
      codeView = null;
      renderTable(codeContent, current().source, workspace.active, {
        copy: (text) => navigator.clipboard.writeText(text).then(() => notice("Copied the rows shown as CSV."), () => notice("The browser refused clipboard access. Use Download view instead.")),
        save: (text, name) => saveBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), name),
      });
      previousRender = key;
    } else if (key !== previousRender) {
      content.hidden = true;
      mediaContent.hidden = true;
      codeContent.hidden = false;
      codeContent.classList.remove("table-view");
      codeView = renderCode(codeContent, current().source, active.language.id);
      previousRender = key;
      if (codeView.formatted) notice("Minified JSON shown formatted. Download gives the file exactly as it is.");
    }
    progress();
    return;
  }
  if (active.kind === "binary") {
    renderMedia(active.binary.mime, active.binary.kind, active.binary.label);
    progress();
    return;
  }
  content.hidden = false;
  codeContent.hidden = true;
  mediaContent.hidden = true;
  codeView = null;
  const styles = getComputedStyle(reader);
  const probe = document.createElement("span");
  probe.textContent = "0000000000";
  content.append(probe);
  const charWidth = probe.getBoundingClientRect().width / 10 || 8.4;
  probe.remove();
  const width = Math.max(20, Math.min(110, Math.floor((reader.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)) / charWidth)));
  const key = JSON.stringify([workspace.active, current().source, width, flavor.value, spoilers]);
  if (key !== previousRender) {
    content.innerHTML = toHtml(renderMarkdown(current().source, width, { flavor: flavor.value as Flavor, spoilers }));
    previousRender = key;
  }
  progress();
}

function loadEditor(): Promise<SourceEditor> {
  return editorLoading ??= import("./code-editor.ts").then(({ createEditor }) => {
    sourceEditor = createEditor(editor, (text) => { current().source = text; documentInfo(); changed(); });
    sourceEditor.view.scrollDOM.addEventListener("scroll", progress);
    return sourceEditor;
  });
}

/** Puts the active file in the editor, keeping its undo history when it is already there. */
async function showEditor(focus: boolean, atEnd: boolean) {
  const path = workspace.active;
  let ready: SourceEditor;
  try { ready = await loadEditor(); }
  catch { editorLoading = undefined; notice("The editor could not load. Check your connection and try again."); setMode(false); return; }
  if (!editing || workspace.active !== path) return;
  if (editorPath !== path || ready.text() !== current().source) {
    ready.load(current().source, path, current().language);
    editorPath = path;
  }
  ready.setWrap(kind().kind === "markdown" || element("wrap").getAttribute("aria-pressed") === "true");
  if (atEnd) ready.view.dispatch({ selection: { anchor: ready.view.state.doc.length }, scrollIntoView: true });
  if (focus) ready.focus();
  progress();
}

function setMode(edit: boolean, focus = true, atEnd = false) {
  if (edit && cloudDocument && !cloudDocument.canEdit) { notice("You have view-only access to this document."); return; }
  if (edit && pasteDocument) { notice("A private link is read-only. Copy or download the file to edit it."); return; }
  if (edit && isBinary()) { notice("Only text is edited here. Download this file to change it elsewhere."); return; }
  if (edit && isLarge()) { notice("A file over 4 MB opens read-only. Download it to change it elsewhere."); return; }
  editing = edit;
  editor.hidden = !edit;
  reader.hidden = edit;
  element("read-mode").setAttribute("aria-pressed", String(!edit));
  element("edit-mode").setAttribute("aria-pressed", String(edit));
  if (edit) void showEditor(focus, atEnd);
  else {
    renderDocument();
    if (focus) reader.focus();
  }
  progress();
}

function documentInfo() {
  const active = kind();
  const ref = current().blob;
  if (ref) {
    const label = active.kind === "binary" ? active.binary.label : active.kind === "code" ? active.language.label : "Markdown";
    element("document-info").textContent = `${label} · ${formatStorage(ref.size)}${ref.digest ? "" : " · read-only"}`;
    return;
  }
  if (active.kind === "binary") {
    element("document-info").textContent = `${active.binary.label} · ${formatBytes(bytesOf(current()).length)}`;
    return;
  }
  if (active.kind === "code") {
    const source = current().source;
    const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
    element("document-info").textContent = `${active.language.label} · ${lines.toLocaleString()} lines · ${formatBytes(encoder.encode(source).length)}`;
    return;
  }
  const words = current().source.trim().split(/\s+/).filter(Boolean).length;
  element("document-info").textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.ceil(words / 220))} min read`;
}

function openDocument(path: string, focus = true) {
  workspace.active = path;
  element("document-name").textContent = path;
  document.title = `${path.split("/").at(-1)} — readm3`;
  renderFiles();
  renderTabs();
  applyKind();
  documentInfo();
  // Code opens ready to type, as in any text editor; Markdown and tables open rendered, as in a reader.
  setMode(isCode() && !isTable() && canEdit(), focus);
  reader.scrollTop = 0;
  progress();
  setFilesOpen(false);
  if (!cloudDocument) changed();
}

/** Adds files, renaming any that would replace an open draft; returns them in the order given. */
function addDocuments(incoming: Document[], name?: string): Document[] {
  const map = new Map(workspace.documents.map((doc) => [doc.path, doc]));
  let total = workspace.documents.reduce((sum, doc) => sum + encoder.encode(doc.source).length, 0);
  const added: Document[] = [];
  for (const doc of incoming) {
    const size = encoder.encode(doc.source).length;
    if (size > MAX_FILE_BYTES || (!signedIn && (total + size > MAX_WORKSPACE_BYTES || map.size >= MAX_FILES))) {
      notice(signedIn ? "A file over 4 MB could not be stored apart. Try opening it again." : `Workspace limit reached: 4 MB per file, 20 MB total, and 1,000 files without an account. ${ACCOUNT_LIMITS}`);
      break;
    }
    if (signedIn && map.size >= MAX_ACCOUNT_FILES && !map.has(doc.path)) {
      notice(`Workspace limit reached: ${MAX_ACCOUNT_FILES.toLocaleString()} files. ${incoming.length - added.length} file(s) were not added.`);
      break;
    }
    // Reopening a file refreshes the copy that matches disk (`readm3 edit .` every morning),
    // but must never silently replace an edited draft: that one keeps its place.
    let path = doc.path;
    let copy = 2;
    const existing = map.get(path);
    if (existing && (existing.source === doc.source || matchesDisk(existing))) {
      total -= encoder.encode(existing.source).length;
      if (existing.blob && existing.blob.id !== doc.blob?.id) void stored.forget(existing.blob);
    }
    else while (map.has(path)) {
      const dot = doc.path.lastIndexOf(".");
      path = dot >= 0 ? `${doc.path.slice(0, dot)} (${copy++})${doc.path.slice(dot)}` : `${doc.path} (${copy++})`;
    }
    const next = { ...doc, path };
    map.set(path, next);
    added.push(next);
    total += size;
  }
  if (!added.length) return added;
  workspace.documents = [...map.values()].sort((a, b) => comparePaths(a.path, b.path));
  if (name) workspace.name = name;
  filter.value = "";
  const first = added.find((doc) => /^readme\b/i.test(doc.path.split("/").at(-1)!)) ?? added[0];
  foldLarge(first.path);
  openDocument(first.path);
  return added;
}

async function importFiles(files: disk.Picked[], name = "Your workspace") {
  if (importBusy) return;
  importBusy = true;
  try {
    const incoming: Document[] = [];
    const handles: (FileSystemFileHandle | undefined)[] = [];
    let bytes = 0;
    let skipped = 0;
    let needAccount = 0;
    let overCount = 0;
    let unreadable = 0;
    const existing = new Map(workspace.documents.map((doc) => [doc.path, doc]));
    for (const { file, path, handle, size = file.size, onDisk } of files) {
      if (!accepts(path)) continue;
      // Past the account's file count nothing more is read.
      if (signedIn && incoming.length >= MAX_ACCOUNT_FILES) { overCount++; continue; }
      // A PDF or image is kept as base64, a third larger than the file; the limits apply to what is stored.
      const cost = binaryType(path) ? Math.ceil(size * 4 / 3) : size;
      // A large file, PDF or image the desktop app opened stays on disk and is read from there: no copy.
      const readFromDisk = !!onDisk && !!handle && (cost > MAX_FILE_BYTES || !!binaryType(path));
      if (cost > MAX_FILE_BYTES || readFromDisk) {
        // Larger files are stored apart as they are (site/blobs.ts), which needs an account.
        if (!signedIn && (!readFromDisk || incoming.length >= MAX_FILES)) { needAccount++; continue; }
        if (size > MAX_BLOB_BYTES) { skipped++; continue; }
        if (!binaryType(path) && looksBinary(await file.slice(0, 8192).text())) { unreadable++; continue; }
        // Opening the folder again keeps a file's stored reference, so sync does not upload it again.
        const before = readFromDisk ? existing.get(path)?.blob : undefined;
        const known = before && before.size === size && !before.digest ? before : undefined;
        const doc: Document = { path, source: "", blob: known ?? newBlobRef(size) };
        if (!binaryType(path) && !languageForName(path)) {
          const language = detectLanguage(path, await file.slice(0, 65536).text());
          if (language !== MARKDOWN) doc.language = language;
        }
        if (readFromDisk) stored.fromDisk(doc.blob!, () => handle!.getFile());
        else await stored.keep(doc.blob!, file);
        incoming.push(doc);
        handles.push(handle);
        continue;
      }
      if (!signedIn && (bytes + cost > MAX_WORKSPACE_BYTES || incoming.length >= MAX_FILES)) { needAccount++; continue; }
      if (binaryType(path)) {
        incoming.push({ path, source: toBase64(new Uint8Array(await file.arrayBuffer())) });
        handles.push(handle);
        bytes += cost;
        continue;
      }
      const text = await file.text();
      if (looksBinary(text)) { unreadable++; continue; }
      const doc: Document = { path, source: text };
      // A name without a known extension is sniffed once here, and the answer travels with the file.
      if (!languageForName(path)) {
        const language = detectLanguage(path, text);
        if (language !== MARKDOWN) doc.language = language;
      }
      incoming.push(doc);
      handles.push(handle);
      bytes += cost;
    }
    if (incoming.length) {
      const added = addDocuments(incoming, name);
      added.forEach((doc, i) => { const handle = handles[i]; if (handle) diskEntries.set(doc.path, { handle, saved: disk.fingerprint(doc.source) }); });
      for (const doc of added) if (!binaryType(doc.path) && !doc.blob) void fileHistory.record(doc.path, doc.source, "opened");
      if (handles.some(Boolean)) { void disk.storeEntries(diskEntries); renderFiles(); void save(); }
    }
    else if (!needAccount) notice(`No readable files found. Open text files (Markdown, JSON, code, config), PDFs or images up to ${signedIn ? "5 GB" : "4 MB"}.`);
    if (needAccount) notice(`${needAccount} file(s) skipped: over 4 MB, or past 20 MB and 1,000 files, without an account. ${ACCOUNT_LIMITS}`);
    if (skipped) notice(`${skipped} file(s) skipped: larger than 5 GB.`);
    if (overCount) notice(`${overCount} file(s) skipped: a workspace holds up to ${MAX_ACCOUNT_FILES.toLocaleString()} files.`);
    if (unreadable) notice(`${unreadable} file(s) skipped: not text, a PDF, an image or an office document.`);
  } catch (error) {
    notice(error instanceof DOMException && error.name === "QuotaExceededError"
      ? "This device's browser storage is full. Free some space, or open fewer large files."
      : "A file could not be read. Try selecting it again.");
  }
  finally { importBusy = false; filesInput.value = ""; folderInput.value = ""; }
}

/** A shared document holds up to 8 MB of source (server/store.ts): base64 for a PDF or an image. */
const MAX_SHARED_SOURCE = 8 * 1024 * 1024;
/**
 * What a share or paste link carries: the text, or for a stored file (large, or a PDF or
 * image the desktop app reads from disk, whose source here is empty) its bytes, fetched
 * from this device or the account, as base64 for a binary. Never an empty file.
 */
async function sharedSource(doc: Document): Promise<string> {
  if (!doc.blob) return doc.source;
  const binary = binaryType(doc.path);
  const limit = binary ? MAX_SHARED_SOURCE * 3 / 4 : MAX_SHARED_SOURCE;
  if (doc.blob.size > limit) throw new Error(`This file is ${formatStorage(doc.blob.size)}; a share link carries up to ${formatStorage(limit)}. Download it and send it another way, or share a smaller copy.`);
  const blob = await stored.bytes(doc.blob, binary?.mime ?? "");
  return binary ? toBase64(new Uint8Array(await blob.arrayBuffer())) : await blob.text();
}

/** Ask AI about the open file, a folder it is in, or the workspace: text as it reads now. */
function askAi() { void showAsk(() => workspace.documents, workspace.active, () => void showTopUp()); }

/** An AI summary of the open document: text as it reads now (unsaved edits included), or the file itself. */
function summarize() {
  const doc = current();
  const active = kind();
  const topUp = () => void showTopUp();
  if (active.kind !== "binary") {
    if (!isLarge()) void showSummary(doc.path, { text: doc.source }, topUp);
    return;
  }
  const { mime } = active.binary;
  const ref = doc.blob;
  const file = ref ? () => stored.bytes(ref, mime) : async () => new Blob([bytesOf(doc).buffer as ArrayBuffer], { type: mime });
  void showSummary(doc.path, { mime, size: ref ? ref.size : bytesOf(doc).length, file }, topUp);
}

function openHistory() {
  if (cloudDocument || pasteDocument || isBinary()) return;
  const path = workspace.active;
  void showHistory(path, (source) => {
    if (workspace.active !== path) return;
    current().source = source;
    previousRender = "";
    documentInfo();
    setMode(editing, false);
    changed();
    void fileHistory.record(path, source, "restored");
    notice("Restored. Save to write it back to disk; the version you left is in History too.");
  }, () => void showTopUp());
}

/** When each disk file was last seen to change, so the watcher reads it only when it moves. */
const diskSeen = new Map<string, number>();
/** Where the round of the other disk files stopped; the open file is checked every time. */
let sweepFrom = 0;
let checking = false;
const SWEEP_BATCH = 100;

/**
 * Every file from disk is watched, not only the open one: a file saved in another editor
 * (or regenerated, or checked out) is reloaded here so sync carries it to the account.
 * The open file is checked on each tick; the rest in rounds of SWEEP_BATCH, all of them
 * when the window comes back into focus.
 */
async function checkDisk(all = false) {
  if (!workspace || cloudDocument || pasteDocument || document.hidden || checking) return;
  checking = true;
  try {
    const others = [...diskEntries.keys()].filter((path) => path !== workspace.active);
    const batch = all ? others : others.slice(sweepFrom, sweepFrom + SWEEP_BATCH);
    sweepFrom = all || sweepFrom + SWEEP_BATCH >= others.length ? 0 : sweepFrom + SWEEP_BATCH;
    for (const path of [workspace.active, ...batch]) await checkDiskFile(path);
  } finally { checking = false; }
}

/**
 * A file from disk that changes underneath the editor (regenerated output, a git
 * checkout, another editor) gets a version in History. With no local edits it is
 * reloaded; with local edits it is left alone and the disk version waits in History.
 */
async function checkDiskFile(path: string) {
  const doc = workspace.documents.find((candidate) => candidate.path === path);
  const entry = diskEntries.get(path);
  if (!doc || !entry) return;
  const name = path.split("/").at(-1);
  const active = () => workspace.active === path && !cloudDocument && !pasteDocument;
  if (doc.blob) {
    // A large file is never read to be checked: its size and time come from a stat.
    const seen = await disk.stat(entry.handle);
    if (!seen) return;
    const before = diskSeen.get(path);
    diskSeen.set(path, seen.modified);
    if (before === undefined ? seen.size === doc.blob.size : before === seen.modified) return;
    const ref = newBlobRef(seen.size);
    stored.fromDisk(ref, () => entry.handle.getFile());
    doc.blob = ref;
    if (active()) { previousRender = ""; openDocument(path, false); notice(`${name} changed on disk and was reloaded.`); }
    changed();
    return;
  }
  let file: File;
  try { file = await entry.handle.getFile(); } catch { return; }
  if (diskSeen.get(path) === file.lastModified) return;
  diskSeen.set(path, file.lastModified);
  if (binaryType(path)) {
    const source = toBase64(new Uint8Array(await file.arrayBuffer()));
    if (source === doc.source || Math.ceil(file.size * 4 / 3) > MAX_FILE_BYTES) return;
    doc.source = source;
    entry.saved = disk.fingerprint(source);
    void disk.storeEntries(diskEntries);
    if (active()) { previousRender = ""; openDocument(path, false); }
    changed();
    return;
  }
  const text = await file.text();
  if (disk.fingerprint(text) === entry.saved) return;
  const edited = unsavedOnDisk(doc);
  await fileHistory.record(path, text, "changed on disk");
  if (edited) { if (active()) notice(`${name} changed on disk. Your unsaved edits are kept; the disk version is in History.`); return; }
  entry.saved = disk.fingerprint(text);
  void disk.storeEntries(diskEntries);
  doc.source = text;
  if (active()) {
    previousRender = "";
    documentInfo();
    setMode(editing, false);
    notice(`${name} changed on disk and was reloaded. History has both versions.`);
  }
  changed();
}

/** What an input or a drop hands over: files with their relative paths, no way back to disk. */
const copies = (files: Iterable<File>): disk.Picked[] => [...files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));

/** Progress while the desktop app reads a folder of thousands of files. */
const reading: disk.Progress = (done, total) => {
  if (total >= 200) saveStatus.textContent = done < total ? `Reading files from disk… ${done.toLocaleString()} of ${total.toLocaleString()}` : "Opening…";
};

async function openFromDisk(folder: boolean) {
  if (!disk.supported()) { (folder ? folderInput : filesInput).click(); return; }
  try {
    if (folder) { const picked = await disk.pickFolder(reading); if (picked) await importFiles(picked.files, picked.name); }
    else { const picked = await disk.pickFiles(reading); if (picked) await importFiles(picked); }
  } catch (error) { notice(error instanceof Error ? error.message : "Could not open from disk."); }
}

/**
 * Ctrl+S: a shared document saves a version; a file from disk is written back to it; a file
 * that has no place on disk yet asks where to put it (Save As), or downloads where the
 * browser cannot write files at all.
 */
async function saveFile(saveAs = false) {
  if (cloudDocument) { await saveCloud(); return; }
  if (pasteDocument || !disk.supported() || current().blob) { download(); return; }
  const doc = current();
  let handle = saveAs ? undefined : diskEntries.get(doc.path)?.handle;
  try {
    handle ??= await disk.saveAs(doc.path.split("/").at(-1)!) ?? undefined;
    if (!handle) return;
    await disk.write(handle, isBinary() ? bytesOf(doc) : doc.source);
    diskEntries.set(doc.path, { handle, saved: disk.fingerprint(doc.source) });
    await disk.storeEntries(diskEntries);
    markUnsaved();
    saveStatus.textContent = `Saved to disk · ${handle.name}`;
    if (!isBinary()) void fileHistory.record(doc.path, doc.source, "saved");
  } catch (error) {
    notice(`${error instanceof Error ? error.message : "Could not write the file."} Use Download to keep a copy.`);
  }
}

function download() {
  const active = kind();
  const doc = current();
  const name = doc.path.split("/").at(-1)!;
  const mime = active.kind === "binary" ? active.binary.mime : `${active.language.mime};charset=utf-8`;
  if (doc.blob) {
    notice(`Preparing ${name} (${formatStorage(doc.blob.size)})…`);
    stored.bytes(doc.blob, mime).then((blob) => saveBlob(blob, name)).catch((error) => notice(error instanceof Error ? error.message : "The file could not be downloaded."));
    return;
  }
  saveBlob(active.kind === "binary" ? new Blob([bytesOf(doc).buffer as ArrayBuffer], { type: mime }) : new Blob([doc.source], { type: mime }), name);
  if (!cloudDocument) void save();
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // A multi-gigabyte file takes a while to hand over; the URL outlives the click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function storePreference(key: string, value: string) { try { localStorage.setItem(`readm3:${key}`, value); } catch { /* The reader still works without preferences. */ } }
function loadPreferences() {
  try {
    for (const [key, select] of [["theme", theme], ["flavor", flavor]] as const) {
      const saved = localStorage.getItem(`readm3:${key}`);
      if (saved && [...select.options].some((option) => option.value === saved)) select.value = saved;
    }
  } catch { /* Use defaults. */ }
  document.documentElement.dataset.theme = theme.value;
}

function bindEvents() {
  element("sync-workspace").onclick = () => void showSync({
    auto: {
      enabled: autoSyncEnabled, set: setAutoSync, now: syncNow, changePassphrase: (userId) => void askPassphrase("create", userId), forgetPassphrase,
      limit: { get: syncLimitMb, set: setSyncLimitMb, fallback: DEFAULT_SYNC_LIMIT_MB },
    },
    read: () => workspace,
    settings: () => ({ theme: theme.value, flavor: flavor.value as Flavor }),
    apply: (incoming, settings) => applySynced(incoming as Workspace | undefined, settings),
  });
  element("cloud-save").onclick = () => void saveCloud();
  element("paste-share").onclick = () => void sharedSource(current()).then((source) => pasteDialog(current().path, source))
    .catch((error) => notice(error instanceof Error ? error.message : "Could not read this file."));
  element("share").onclick = () => {
    if (pendingSave && cloudDocument) { notice("Save your changes before changing sharing settings."); return; }
    const doc = current();
    const task = cloudDocument ? sharing(cloudDocument, adoptCloud) : sharedSource(doc).then((source) => publish(doc.path, source, (created) => {
      history.pushState(null, "", `/viewer?doc=${created.id}`); adoptCloud(created);
    }));
    void task.catch(error => notice(error instanceof Error ? error.message : "Could not open sharing."));
  };
  element("paste-delete").onclick = async () => {
    if (!pasteToken || !confirm("Delete this paste? The link stops working for everyone.")) return;
    try { await request(`pastes/${pasteToken}`, "DELETE"); location.href = "/viewer"; }
    catch (error) { notice(error instanceof Error ? error.message : "Could not delete this paste."); }
  };
  element("summarize").onclick = summarize;
  element("ask-ai").onclick = askAi;
  element("copy").onclick = async () => {
    // Copy what is on screen: formatted JSON when it was shown formatted, the source otherwise.
    const text = codeView?.text ?? current().source;
    try { await navigator.clipboard.writeText(text); notice(`Copied ${current().path} to the clipboard.`); }
    catch { notice("The browser refused clipboard access. Select the text and copy it, or use Download."); }
  };
  element("fold-all").onclick = () => editing ? sourceEditor?.foldAll() : codeView?.foldAll();
  element("unfold-all").onclick = () => editing ? sourceEditor?.unfoldAll() : codeView?.unfoldAll();
  element("wrap").onclick = () => {
    const on = element("wrap").getAttribute("aria-pressed") !== "true";
    element("wrap").setAttribute("aria-pressed", String(on));
    codeView?.setWrap(on);
    if (editing && !isMarkdown()) sourceEditor?.setWrap(on);
  };
  element("history").onclick = () => {
    if (!cloudDocument) { openHistory(); return; }
    if (pendingSave) { notice("Save or download your draft before restoring a version."); return; }
    void versionHistory(cloudDocument, adoptCloud).catch(error => notice(error instanceof Error ? error.message : "Could not load history."));
  };
  element("open-files").onclick = () => void openFromDisk(false);
  element("open-folder").onclick = () => void openFromDisk(true);
  filesInput.onchange = () => void importFiles(copies(filesInput.files ?? []));
  folderInput.onchange = () => void importFiles(copies(folderInput.files ?? []));
  element("new-file").onclick = () => { addDocuments([{ path: "Untitled.md", source: "# Untitled\n\n" }]); setMode(true, true, true); };
  filter.oninput = () => renderFiles();
  element("read-mode").onclick = () => setMode(false);
  element("edit-mode").onclick = () => setMode(true);
  element("download").onclick = download;
  element("toggle-files").onclick = () => setFilesOpen(!document.body.classList.contains("files-open"));
  reader.addEventListener("click", () => setFilesOpen(false));
  reader.onscroll = progress;
  theme.onchange = () => { document.documentElement.dataset.theme = theme.value; storePreference("theme", theme.value); };
  flavor.onchange = () => { storePreference("flavor", flavor.value); renderDocument(); };
  element("spoilers").onclick = () => { spoilers = !spoilers; element("spoilers").setAttribute("aria-pressed", String(spoilers)); renderDocument(); };
  element("help").onclick = () => helpDialog.showModal();
  element("open-url").onclick = () => urlDialog.showModal();
  element("close-url").onclick = () => urlDialog.close();
  element<HTMLFormElement>("url-form").onsubmit = (event) => { event.preventDefault(); void importUrl(); };
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", (event) => {
    if (pendingSave || saveFailed) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && pendingSave && !cloudDocument) void save(); });
  let dragDepth = 0;
  document.addEventListener("dragenter", (event) => {
    if (!cloudDocument && event.dataTransfer?.types.includes("Files")) { event.preventDefault(); dragDepth++; document.body.classList.add("dragging"); }
  });
  document.addEventListener("dragover", (event) => { if (!cloudDocument && event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
  document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  document.addEventListener("drop", (event) => {
    event.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    if (!cloudDocument && event.dataTransfer) void importFiles(copies(event.dataTransfer.files));
  });
  new ResizeObserver(() => renderDocument()).observe(reader);
}

function onKey(event: KeyboardEvent) {
  // The editor's own keys (Escape closing find, Ctrl+D, Ctrl+/) are already handled.
  if (document.querySelector("dialog[open]") || event.isComposing || event.defaultPrevented) return;
  const target = event.target as HTMLElement;
  const typing = target.matches("input, textarea, select, [contenteditable]");
  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") || event.key === "F1") {
    event.preventDefault(); showPalette(event.shiftKey || event.key === "F1" ? ">" : ""); return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveFile(event.shiftKey); return; }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape") {
    if (editing) setMode(false);
    else { filter.value = ""; renderFiles(); setFilesOpen(false); reader.focus(); }
    event.preventDefault(); return;
  }
  if (target === filter && ["ArrowDown", "Enter"].includes(event.key)) {
    fileList.querySelector<HTMLButtonElement>("button")?.focus();
    event.preventDefault(); return;
  }
  if (typing) return;
  if (event.key === "/") {
    event.preventDefault();
    // Reading a table, `/` filters its rows, as in the terminal reader.
    const rows = !editing && isTable() ? codeContent.querySelector<HTMLInputElement>(".table-filter") : null;
    if (rows) { rows.focus(); return; }
    setFilesOpen(true); filter.focus(); return;
  }
  if (event.key === "?") { event.preventDefault(); helpDialog.showModal(); return; }
  if (fileList.contains(target)) {
    const rows = [...fileList.querySelectorAll<HTMLButtonElement>("button")];
    const index = rows.indexOf(target as HTMLButtonElement);
    if (["ArrowDown", "j", "ArrowUp", "k", "Home", "End"].includes(event.key)) {
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : index + (["ArrowDown", "j"].includes(event.key) ? 1 : -1);
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus(); event.preventDefault(); return;
    }
    if (target.hasAttribute("aria-expanded") && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      const path = target.dataset.path!;
      if (event.key === "ArrowLeft") collapsed.add(path); else collapsed.delete(path);
      renderFiles(path); event.preventDefault(); return;
    }
  }
  if (target !== reader && !fileList.contains(target) && target !== document.body) return;
  if (event.key === "e" || event.key === "i") { event.preventDefault(); setMode(true); }
  else if (event.key === "s") { event.preventDefault(); element("spoilers").click(); }
  else if (target === reader) {
    const amount: Record<string, number> = { j: 52, ArrowDown: 52, k: -52, ArrowUp: -52, " ": reader.clientHeight * .85, b: -reader.clientHeight * .85, PageDown: reader.clientHeight * .85, PageUp: -reader.clientHeight * .85 };
    if (event.key === "g" || event.key === "G") { reader.scrollTop = event.key === "g" ? 0 : reader.scrollHeight; event.preventDefault(); }
    else if (event.key in amount) { reader.scrollTop += amount[event.key]; event.preventDefault(); }
  }
}

/** The message shown in the URL dialog when a fetch fails, worded for the likely cause. */
function urlErrorMessage(cause: unknown): string {
  if (cause instanceof TypeError) return "Could not fetch this URL. The host may block browser access (CORS), or you may be offline. Download the file and use Open files.";
  return cause instanceof Error ? cause.message : "Unable to open that URL.";
}

/**
 * Opens a Markdown document from a public URL: `/viewer?url=https://host/doc.md`.
 * The link is what a Markdown-only site puts on every page so a reader can render it
 * here without leaving Markdown behind on their side. On failure the URL dialog opens
 * with the address filled in and the error shown, so the reader can see what happened.
 */
async function openUrlParam(input: string) {
  element<HTMLInputElement>("url-input").value = input;
  saveStatus.textContent = "Opening URL…";
  try {
    await fetchDocument(input);
  } catch (cause) {
    element("url-error").textContent = urlErrorMessage(cause);
    urlDialog.showModal();
  }
}

async function importUrl() {
  const button = element<HTMLButtonElement>("load-url");
  const error = element("url-error");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "Opening…";
  try {
    await fetchDocument(element<HTMLInputElement>("url-input").value.trim());
    urlDialog.close();
  } catch (cause) {
    error.textContent = urlErrorMessage(cause);
  } finally { button.disabled = false; button.textContent = "Open document"; }
}

/** Fetches a raw Markdown URL and adds it to the workspace; throws a readable Error on any failure. */
async function fetchDocument(input: string) {
  const url = rawUrl(input);
  const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`The host returned HTTP ${response.status}. Check the URL and try again.`);
  const type = response.headers.get("content-type") ?? "";
  const givenName = decodeURIComponent(url.pathname.split("/").at(-1) || "").replace(/[/\\]/g, "-");
  if (type.includes("text/html") && !/\.html?$/i.test(givenName)) throw new Error("That URL returns a web page. Use the raw file URL instead.");
  const limit = signedIn ? MAX_BLOB_BYTES : MAX_FILE_BYTES;
  const tooLarge = () => new Error(signedIn ? "This file is over the 5 GB limit." : `This file is over 4 MB. ${ACCOUNT_LIMITS}`);
  if (Number(response.headers.get("content-length")) > limit) throw tooLarge();
  const stream = response.body?.getReader();
  if (!stream) throw new Error("The host returned an empty response.");
  // Blob parts, not one array: a browser keeps a large Blob on disk.
  const parts: Blob[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await stream.cancel(); throw tooLarge(); }
      parts.push(new Blob([value as BlobPart]));
    }
  } finally { stream.releaseLock(); }
  const whole = new Blob(parts);
  let name = givenName || "Document.md";
  if (!accepts(name)) name = "Document.md";
  // A PDF or image served without an extension in its path still gets one from its type.
  if (!binaryType(name)) {
    if (type.startsWith("application/pdf")) name += ".pdf";
    else if (type.startsWith("image/")) name += `.${type.slice(6).split(/[;+]/)[0]}`;
  }
  if (length > MAX_FILE_BYTES || (binaryType(name) && Math.ceil(length * 4 / 3) > MAX_FILE_BYTES)) {
    if (!binaryType(name) && looksBinary(await whole.slice(0, 8192).text())) throw new Error("That URL is not a text file, PDF or image.");
    const doc: Document = { path: name, source: "", blob: newBlobRef(length) };
    await stored.keep(doc.blob!, whole);
    addDocuments([doc]);
    return;
  }
  const bytes = new Uint8Array(await whole.arrayBuffer());
  if (binaryType(name)) { addDocuments([{ path: name, source: toBase64(bytes) }]); return; }
  const text = new TextDecoder().decode(bytes);
  if (looksBinary(text)) throw new Error("That URL is not a text file, PDF or image.");
  const doc: Document = { path: name, source: text };
  if (!languageForName(name)) {
    const language = detectLanguage(name, text);
    if (language !== MARKDOWN) doc.language = language;
  }
  addDocuments([doc]);
}

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }>; }
interface LaunchQueue { setConsumer(consumer: (params: { files: readonly FileSystemHandle[] }) => void): void; }
/** "Open with readm3" from the operating system, once the app is installed. */
function receiveLaunches() {
  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer((params) => {
    if (!params.files.length || cloudDocument || pasteDocument) return;
    void disk.launched(params.files).then((files) => importFiles(files)).catch(() => notice("The file could not be opened."));
  });
  // The desktop app: files and folders from the command line or "Open with", now and while running.
  if (disk.desktop && !cloudDocument && !pasteDocument) {
    const open = (files: disk.DesktopFile[]) => {
      if (!files.length) return;
      const folder = files.find((file) => file.relative)?.relative!.split("/")[0];
      void disk.fromDesktop(files, reading).then((picked) => importFiles(picked, folder)).catch(() => notice("A file could not be read from disk."));
    };
    void disk.desktop.takeLaunchFiles().then(open);
    disk.desktop.onOpenFiles(open);
  }
  // The desktop menu runs the palette's commands by name; "" and ">" open the palette itself.
  (window as unknown as { readm3Command?: (label: string) => void }).readm3Command = (label) => {
    if (label === "" || label === ">") showPalette(label);
    else commands().find((command) => command.label === label)?.run();
  };
}

/**
 * "Open in app": a readm3:// link the desktop app registers, naming this page so the app
 * opens the same document, share or paste. When nothing answers (the page keeps focus),
 * the button turns into the download link.
 */
function setupOpenInDesktop() {
  // Not inside the app itself, and not on a phone or tablet, which have no desktop app.
  if (disk.desktop || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || matchMedia("(max-width: 720px)").matches) return;
  const button = element<HTMLButtonElement>("open-desktop");
  button.hidden = false;
  let missing = false;
  button.onclick = () => {
    if (missing) { window.open("https://github.com/profullstack/readm3/releases/latest", "_blank", "noopener"); return; }
    let left = false;
    const away = () => { left = true; };
    window.addEventListener("blur", away, { once: true });
    location.href = `readm3://open?url=${encodeURIComponent(location.href)}`;
    setTimeout(() => {
      window.removeEventListener("blur", away);
      if (left || document.hidden) return;
      missing = true;
      button.textContent = "Get the app";
      notice("The readm3 desktop app did not open. Get the app to install it, or run: readm3 desktop install");
    }, 1500);
  };
}

async function setupPwa() {
  const connection = element("connection");
  const connectionStatus = () => { connection.textContent = navigator.onLine ? "Browser workspace" : "Offline · local workspace"; };
  window.addEventListener("online", connectionStatus);
  window.addEventListener("offline", connectionStatus);
  connectionStatus();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    const install = element("install-app");
    install.hidden = false;
    install.onclick = async () => { await (event as InstallPrompt).prompt(); await (event as InstallPrompt).userChoice; install.hidden = true; };
  });
  window.addEventListener("appinstalled", () => { element("install-app").hidden = true; notice("readm3 is installed. Your workspace is ready to go."); });
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/viewer-sw.js", { scope: "/viewer", updateViaCache: "none" });
    const update = () => {
      if (!registration.waiting || !navigator.serviceWorker.controller) return;
      const button = element<HTMLButtonElement>("update");
      button.hidden = false;
      button.onclick = async () => {
        await save();
        if (pendingSave) { notice("Download your edits before updating; browser storage is unavailable."); return; }
        button.disabled = true;
        navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
        registration.waiting?.postMessage("activate");
      };
    };
    update();
    registration.addEventListener("updatefound", () => registration.installing?.addEventListener("statechange", update));
  } catch { notice("Offline setup is unavailable. The reader still works while this page is open."); }
}

async function refreshAccount() {
  try { signedIn = !!(await request<{ user: CloudUser | null }>("me")).user; }
  catch { /* Offline: the last answer stands. */ }
  updateUsage(true);
}

/** The header meter: this workspace's files and storage against the plan (site/usage.ts). */
function updateUsage(force = false) {
  if (!workspace || cloudDocument || pasteDocument) return;
  const bytes = workspace.documents.reduce((sum, doc) => sum + doc.source.length, 0);
  void refreshUsage({ files: workspace.documents.length, bytes, signedIn }, force);
}

async function start() {
  loadPreferences();
  if (pasteToken) {
    try {
      adoptPaste(await request<PasteView>(`pastes/${pasteToken}`));
      bindEvents();
      element("connection").textContent = "Private link · online";
    } catch (error) {
      element("document-name").textContent = "Paste unavailable";
      content.textContent = error instanceof Error ? error.message : "Could not open this paste.";
      saveStatus.textContent = "No document loaded";
      element("file-pane").hidden = true;
      document.querySelectorAll<HTMLButtonElement>(".document-actions button").forEach(button => button.disabled = true);
    }
    return;
  }
  if (shareToken || cloudId) {
    try {
      const doc = shareToken ? await request<CloudDocument>(`shared/${shareToken}`) : await request<CloudDocument>(`documents/${encodeURIComponent(cloudId!)}`);
      adoptCloud(doc);
      bindEvents();
      if (doc.canEdit && new URLSearchParams(location.search).get("edit") === "1") setMode(true);
      element("connection").textContent = "Shared workspace · online";
      return;
    } catch (error) {
      element("document-name").textContent = "Document unavailable";
      content.textContent = `${error instanceof Error ? error.message : "Could not open this document."}\n\nSign in from Workspaces if this file is private. Shared documents need an internet connection.`;
      saveStatus.textContent = "No document loaded";
      element("file-pane").hidden = true;
      document.querySelectorAll<HTMLButtonElement>(".document-actions button").forEach(button => button.disabled = true);
      return;
    }
  }
  try { workspace = (await restore())!; } catch { /* A fresh in-memory workspace still works. */ }
  diskEntries = await disk.loadEntries();
  diskSynced = await disk.loadSynced();
  let savedActive: string | undefined;
  try {
    const saved = JSON.parse(localStorage.getItem("readm3:tabs") ?? "{}") as { tabs?: string[]; active?: string };
    tabs = Array.isArray(saved.tabs) ? saved.tabs : [];
    savedActive = saved.active;
  } catch { /* A fresh tab bar. */ }
  if (!workspace?.documents?.length || !workspace.documents.some((doc) => doc.path === workspace.active)) {
    const seed = await fetch(__SEED_URL__);
    if (!seed.ok) throw new Error("Could not load the starter documents. Reload to try again.");
    workspace = await seed.json() as Workspace;
  }
  reattachDisk();
  if (savedActive && workspace.documents.some((doc) => doc.path === savedActive)) workspace.active = savedActive;
  workspace.documents.sort((a, b) => comparePaths(a.path, b.path));
  openDocument(workspace.active, false);
  bindEvents();
  await save();
  // The account decides the limits before anything is opened from a link or the desktop.
  element("usage").onclick = showUsage;
  await refreshAccount();
  window.addEventListener("focus", () => void refreshAccount());
  const params = new URLSearchParams(location.search);
  if (params.has("new")) { element("new-file").click(); history.replaceState(null, "", "/viewer"); }
  // readm3.com/talk lands here.
  if (params.has("ask")) { history.replaceState(null, "", "/viewer"); askAi(); }
  const remote = params.get("url")?.trim();
  if (remote) await openUrlParam(remote);
  receiveLaunches();
  // Files from disk changed while readm3 was closed are picked up now, not one round at a time.
  void checkDisk(true);
  setInterval(() => void checkDisk(), 5000);
  window.addEventListener("focus", () => void checkDisk(true));
  const topup = params.get("topup");
  if (topup) { history.replaceState(null, "", "/viewer"); void awaitTopUp(topup, notice); }
  void setupPwa();
  setupOpenInDesktop();
  startAutoSync({
    read: () => ({ name: workspace.name, active: workspace.active, documents: workspace.documents }),
    settings: () => ({ theme: theme.value, flavor: flavor.value as Flavor }),
    apply: (incoming, settings) => applySynced(incoming as Workspace, settings),
    status: (text) => { element("sync-note").textContent = text; if (text.startsWith("Synced")) updateUsage(true); },
    device: disk.desktop ? "desktop" : "browser",
    seedUrl: __SEED_URL__,
    app: "readm3 web",
  });
}

start().catch((error) => { saveStatus.textContent = error instanceof Error ? error.message : "Unable to open the workspace. Reload to try again."; });
