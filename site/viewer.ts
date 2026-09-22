import { action, request, type CloudDocument } from "./cloud.ts";
import { publish, sharing, history as versionHistory } from "./sharing.ts";
import { showSync } from "./sync.ts";
import { renderMarkdown } from "../src/markdown.ts";
import type { Flavor } from "../src/flavors.ts";
import { toHtml } from "./html.ts";
import { renderCode, type CodeView } from "./code-view.ts";
import { binaryType, detectLanguage, languageForName, looksBinary, MARKDOWN } from "../src/code.ts";
import { accepts, bytesOf, comparePaths, kindOf, MAX_FILE_BYTES, MAX_FILES, MAX_WORKSPACE_BYTES, persist, rawUrl, restore, toBase64, type Document, type Workspace } from "./workspace.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reader = element("reader");
const content = element("document-content");
const editor = element<HTMLTextAreaElement>("editor");
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
let mediaUrl: string | null = null;
/** What the active document is on screen: Markdown, code in some language, or a PDF or image. */
const kind = () => kindOf(current());
const isCode = () => kind().kind === "code";
const isBinary = () => kind().kind === "binary";
const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Shows the controls that make sense for the active document's kind. */
function applyKind() {
  const current = kind();
  element("flavor-label").hidden = current.kind !== "markdown";
  element("spoilers").hidden = current.kind !== "markdown";
  element("code-tools").hidden = current.kind !== "code";
  element("copy").hidden = current.kind === "binary";
  element("file-mark").textContent = current.kind === "markdown" ? "M↓" : current.kind === "code" ? current.language.extensions[0]!.toUpperCase() : current.binary.label.split(" ")[0]!.toUpperCase();
  element<HTMLButtonElement>("edit-mode").disabled = current.kind === "binary" || !!pasteDocument || (!!cloudDocument && !cloudDocument.canEdit);
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
      pendingSave = false;
      saveFailed = false;
      saveStatus.textContent = "Saved on this device";
    }
  } catch {
    saveFailed = true;
    saveStatus.textContent = "Browser storage unavailable — download to keep your files";
  }
}

function changed() {
  revision++;
  pendingSave = true;
  if (cloudDocument) { saveStatus.textContent = "Unsaved changes · save a new version"; return; }
  saveStatus.textContent = "Saving on this device…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 300);
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
    if (!hidden) fileList.append(fileRow(doc.path, parts.at(-1)!, parts.length - 1, false));
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

function fileRow(path: string, name: string, depth: number, directory: boolean) {
  const row = document.createElement("button");
  row.className = `file-row${directory ? " folder-row" : ""}`;
  row.dataset.path = path;
  row.style.paddingLeft = `${10 + depth * 15}px`;
  row.title = path;
  if (!directory && path === workspace.active) row.setAttribute("aria-current", "page");
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  const fileKind = directory ? null : kindOf(workspace.documents.find((doc) => doc.path === path)!);
  icon.textContent = directory ? (filter.value || !collapsed.has(path) ? "▾" : "▸") : fileKind!.kind === "markdown" ? "M↓" : fileKind!.kind === "code" ? "{}" : "▣";
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
  const pane = editing ? editor : reader;
  const range = pane.scrollHeight - pane.clientHeight;
  element("reading-progress").textContent = `${range <= 0 ? 100 : Math.round(pane.scrollTop / range * 100)}%`;
}

let previousRender = "";
/** A PDF or image: the browser's own viewer on a blob URL, which is revoked when the next one is made. */
function renderMedia(mime: string, media: "pdf" | "image", label: string) {
  const key = JSON.stringify(["media", workspace.active, current().source.length]);
  if (key === previousRender) return;
  previousRender = key;
  content.hidden = true;
  codeContent.hidden = true;
  mediaContent.hidden = false;
  codeView = null;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(new Blob([bytesOf(current()).buffer as ArrayBuffer], { type: mime }));
  mediaContent.replaceChildren();
  if (media === "image") {
    const image = document.createElement("img");
    image.src = mediaUrl;
    image.alt = current().path;
    mediaContent.append(image);
  } else {
    const embed = document.createElement("embed");
    embed.type = mime;
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

function renderDocument() {
  if (!workspace || editing) return;
  const active = kind();
  if (active.kind === "code") {
    const key = JSON.stringify(["code", workspace.active, current().source, active.language.id]);
    if (key !== previousRender) {
      content.hidden = true;
      mediaContent.hidden = true;
      codeContent.hidden = false;
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

function setMode(edit: boolean, focus = true) {
  if (edit && cloudDocument && !cloudDocument.canEdit) { notice("You have view-only access to this document."); return; }
  if (edit && pasteDocument) { notice("A private link is read-only. Copy or download the file to edit it."); return; }
  if (edit && isBinary()) { notice("A PDF or image cannot be edited here. Download it to change it elsewhere."); return; }
  editing = edit;
  editor.hidden = !edit;
  reader.hidden = edit;
  element("read-mode").setAttribute("aria-pressed", String(!edit));
  element("edit-mode").setAttribute("aria-pressed", String(edit));
  if (edit) {
    editor.value = current().source;
    if (focus) editor.focus();
  } else {
    renderDocument();
    if (focus) reader.focus();
  }
  progress();
}

function documentInfo() {
  const active = kind();
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
  applyKind();
  documentInfo();
  setMode(false, focus);
  reader.scrollTop = 0;
  progress();
  setFilesOpen(false);
  if (!cloudDocument) changed();
}

function addDocuments(incoming: Document[], name?: string) {
  const map = new Map(workspace.documents.map((doc) => [doc.path, doc]));
  let total = workspace.documents.reduce((sum, doc) => sum + encoder.encode(doc.source).length, 0);
  const added: Document[] = [];
  for (const doc of incoming) {
    const size = encoder.encode(doc.source).length;
    if (size > MAX_FILE_BYTES || total + size > MAX_WORKSPACE_BYTES || map.size >= MAX_FILES) {
      notice("Workspace limit reached: 4 MB per file, 20 MB total, and 1,000 files. Download files you want to keep.");
      break;
    }
    // Reopening a file must never silently replace an edited draft.
    let path = doc.path;
    let copy = 2;
    while (map.has(path)) {
      const dot = doc.path.lastIndexOf(".");
      path = dot >= 0 ? `${doc.path.slice(0, dot)} (${copy++})${doc.path.slice(dot)}` : `${doc.path} (${copy++})`;
    }
    const next = { ...doc, path };
    map.set(path, next);
    added.push(next);
    total += size;
  }
  if (!added.length) return;
  workspace.documents = [...map.values()].sort((a, b) => comparePaths(a.path, b.path));
  if (name) workspace.name = name;
  filter.value = "";
  collapsed.clear();
  const first = added.find((doc) => /^readme\b/i.test(doc.path.split("/").at(-1)!)) ?? added[0];
  openDocument(first.path);
}

async function importFiles(files: File[]) {
  if (importBusy) return;
  importBusy = true;
  try {
    const incoming: Document[] = [];
    let bytes = 0;
    let skipped = 0;
    let unreadable = 0;
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      if (!accepts(path)) continue;
      // A PDF or image is kept as base64, a third larger than the file; the limits apply to what is stored.
      const cost = binaryType(path) ? Math.ceil(file.size * 4 / 3) : file.size;
      if (cost > MAX_FILE_BYTES || bytes + cost > MAX_WORKSPACE_BYTES || incoming.length >= MAX_FILES) { skipped++; continue; }
      if (binaryType(path)) {
        incoming.push({ path, source: toBase64(new Uint8Array(await file.arrayBuffer())) });
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
      bytes += cost;
    }
    if (incoming.length) addDocuments(incoming, "Your workspace");
    else notice("No readable files found. Open text files (Markdown, JSON, code, config), PDFs or images up to 4 MB.");
    if (skipped) notice(`${skipped} file(s) skipped because of size or workspace limits.`);
    if (unreadable) notice(`${unreadable} file(s) skipped: not text, PDF or image.`);
  } catch { notice("A file could not be read. Try selecting it again."); }
  finally { importBusy = false; filesInput.value = ""; folderInput.value = ""; }
}

function download() {
  const active = kind();
  const blob = active.kind === "binary"
    ? new Blob([bytesOf(current()).buffer as ArrayBuffer], { type: active.binary.mime })
    : new Blob([current().source], { type: `${active.language.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = current().path.split("/").at(-1)!;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (!cloudDocument) void save();
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
    read: () => workspace,
    settings: () => ({ theme: theme.value, flavor: flavor.value as Flavor }),
    async apply(incoming, settings) {
      clearTimeout(saveTimer);
      if (incoming) {
        await persist(incoming);
        workspace = incoming;
        filter.value = "";
        collapsed.clear();
      }
      if (settings?.theme && [...theme.options].some((option) => option.value === settings.theme)) theme.value = settings.theme;
      if (settings?.flavor) flavor.value = settings.flavor;
      storePreference("theme", theme.value);
      storePreference("flavor", flavor.value);
      document.documentElement.dataset.theme = theme.value;
      openDocument(workspace.active, false);
      await save();
    },
  });
  element("cloud-save").onclick = () => void saveCloud();
  element("share").onclick = () => {
    if (pendingSave && cloudDocument) { notice("Save your changes before changing sharing settings."); return; }
    const task = cloudDocument ? sharing(cloudDocument, adoptCloud) : publish(current().path, current().source, doc => {
      history.pushState(null, "", `/viewer?doc=${doc.id}`); adoptCloud(doc);
    });
    void task.catch(error => notice(error instanceof Error ? error.message : "Could not open sharing."));
  };
  element("paste-delete").onclick = async () => {
    if (!pasteToken || !confirm("Delete this paste? The link stops working for everyone.")) return;
    try { await request(`pastes/${pasteToken}`, "DELETE"); location.href = "/viewer"; }
    catch (error) { notice(error instanceof Error ? error.message : "Could not delete this paste."); }
  };
  element("copy").onclick = async () => {
    // Copy what is on screen: formatted JSON when it was shown formatted, the source otherwise.
    const text = codeView?.text ?? current().source;
    try { await navigator.clipboard.writeText(text); notice(`Copied ${current().path} to the clipboard.`); }
    catch { notice("The browser refused clipboard access. Select the text and copy it, or use Download."); }
  };
  element("fold-all").onclick = () => codeView?.foldAll();
  element("unfold-all").onclick = () => codeView?.unfoldAll();
  element("wrap").onclick = () => {
    const on = element("wrap").getAttribute("aria-pressed") !== "true";
    element("wrap").setAttribute("aria-pressed", String(on));
    codeView?.setWrap(on);
  };
  element("history").onclick = () => {
    if (!cloudDocument) return;
    if (pendingSave) { notice("Save or download your draft before restoring a version."); return; }
    void versionHistory(cloudDocument, adoptCloud).catch(error => notice(error instanceof Error ? error.message : "Could not load history."));
  };
  element("open-files").onclick = () => filesInput.click();
  element("open-folder").onclick = () => folderInput.click();
  filesInput.onchange = () => void importFiles([...filesInput.files ?? []]);
  folderInput.onchange = () => void importFiles([...folderInput.files ?? []]);
  element("new-file").onclick = () => { addDocuments([{ path: "Untitled.md", source: "# Untitled\n\n" }]); setMode(true); editor.setSelectionRange(editor.value.length, editor.value.length); };
  filter.oninput = () => renderFiles();
  element("read-mode").onclick = () => setMode(false);
  element("edit-mode").onclick = () => setMode(true);
  element("download").onclick = download;
  element("toggle-files").onclick = () => setFilesOpen(!document.body.classList.contains("files-open"));
  reader.addEventListener("click", () => setFilesOpen(false));
  reader.onscroll = progress;
  editor.onscroll = progress;
  editor.oninput = () => { current().source = editor.value; documentInfo(); changed(); };
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
    if (!cloudDocument && event.dataTransfer) void importFiles([...event.dataTransfer.files]);
  });
  new ResizeObserver(() => renderDocument()).observe(reader);
}

function onKey(event: KeyboardEvent) {
  if (document.querySelector("dialog[open]") || event.isComposing) return;
  const target = event.target as HTMLElement;
  const typing = target.matches("input, textarea, select, [contenteditable]");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (cloudDocument) void saveCloud(); else download(); return; }
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
  if (event.key === "/") { event.preventDefault(); setFilesOpen(true); filter.focus(); return; }
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
  if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) throw new Error("This file exceeds the 4 MB limit.");
  const stream = response.body?.getReader();
  if (!stream) throw new Error("The host returned an empty response.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FILE_BYTES) { await stream.cancel(); throw new Error("This file exceeds the 4 MB limit."); }
      chunks.push(value);
    }
  } finally { stream.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let name = givenName || "Document.md";
  if (!accepts(name)) name = "Document.md";
  // A PDF or image served without an extension in its path still gets one from its type.
  if (!binaryType(name)) {
    if (type.startsWith("application/pdf")) name += ".pdf";
    else if (type.startsWith("image/")) name += `.${type.slice(6).split(/[;+]/)[0]}`;
  }
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
  if (!workspace?.documents?.length || !workspace.documents.some((doc) => doc.path === workspace.active)) {
    const seed = await fetch("__SEED_URL__");
    if (!seed.ok) throw new Error("Could not load the starter documents. Reload to try again.");
    workspace = await seed.json() as Workspace;
  }
  workspace.documents.sort((a, b) => comparePaths(a.path, b.path));
  openDocument(workspace.active, false);
  bindEvents();
  await save();
  const params = new URLSearchParams(location.search);
  if (params.has("new")) { element("new-file").click(); history.replaceState(null, "", "/viewer"); }
  const remote = params.get("url")?.trim();
  if (remote) await openUrlParam(remote);
  void setupPwa();
}

start().catch((error) => { saveStatus.textContent = error instanceof Error ? error.message : "Unable to open the workspace. Reload to try again."; });
