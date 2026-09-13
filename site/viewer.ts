import { renderMarkdown } from "../src/markdown.ts";
import type { Flavor } from "../src/flavors.ts";
import { toHtml } from "./html.ts";
import { accepts, comparePaths, MAX_FILE_BYTES, MAX_FILES, MAX_WORKSPACE_BYTES, persist, rawUrl, restore, type Document, type Workspace } from "./workspace.ts";

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
    empty.textContent = "No Markdown files match your filter.";
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
  icon.textContent = directory ? (filter.value || !collapsed.has(path) ? "▾" : "▸") : "M↓";
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
function renderDocument() {
  if (!workspace || editing) return;
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
  const words = current().source.trim().split(/\s+/).filter(Boolean).length;
  element("document-info").textContent = `${words.toLocaleString()} words · ${Math.max(1, Math.ceil(words / 220))} min read`;
}

function openDocument(path: string, focus = true) {
  workspace.active = path;
  element("document-name").textContent = path;
  document.title = `${path.split("/").at(-1)} — readm3`;
  renderFiles();
  documentInfo();
  setMode(false, focus);
  reader.scrollTop = 0;
  progress();
  setFilesOpen(false);
  changed();
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
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      if (!accepts(path)) continue;
      if (file.size > MAX_FILE_BYTES || bytes + file.size > MAX_WORKSPACE_BYTES || incoming.length >= MAX_FILES) { skipped++; continue; }
      incoming.push({ path, source: await file.text() });
      bytes += file.size;
    }
    if (incoming.length) addDocuments(incoming, "Your Markdown workspace");
    else notice("No readable Markdown files found. Open .md, .markdown, .mdown, .mkd, or .mdx files up to 4 MB.");
    if (skipped) notice(`${skipped} file(s) skipped because of size or workspace limits.`);
  } catch { notice("A file could not be read. Try selecting it again."); }
  finally { importBusy = false; filesInput.value = ""; folderInput.value = ""; }
}

function download() {
  const url = URL.createObjectURL(new Blob([current().source], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = current().path.split("/").at(-1)!;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  void save();
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
  document.addEventListener("visibilitychange", () => { if (document.hidden && pendingSave) void save(); });
  let dragDepth = 0;
  document.addEventListener("dragenter", (event) => {
    if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); dragDepth++; document.body.classList.add("dragging"); }
  });
  document.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
  document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  document.addEventListener("drop", (event) => {
    event.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    if (event.dataTransfer) void importFiles([...event.dataTransfer.files]);
  });
  new ResizeObserver(() => renderDocument()).observe(reader);
}

function onKey(event: KeyboardEvent) {
  if (helpDialog.open || urlDialog.open || event.isComposing) return;
  const target = event.target as HTMLElement;
  const typing = target.matches("input, textarea, select, [contenteditable]");
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); download(); return; }
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

async function importUrl() {
  const button = element<HTMLButtonElement>("load-url");
  const error = element("url-error");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "Opening…";
  try {
    const url = rawUrl(element<HTMLInputElement>("url-input").value.trim());
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`The host returned HTTP ${response.status}. Check the URL and try again.`);
    if (response.headers.get("content-type")?.includes("text/html")) throw new Error("That URL returns a web page. Use the raw Markdown file URL instead.");
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
    let name = decodeURIComponent(url.pathname.split("/").at(-1) || "Document.md").replace(/[/\\]/g, "-");
    if (!accepts(name)) name = "Document.md";
    addDocuments([{ path: name, source: new TextDecoder().decode(bytes) }]);
    urlDialog.close();
  } catch (cause) {
    error.textContent = cause instanceof TypeError ? "Could not fetch this URL. The host may block browser access (CORS), or you may be offline. Download the file and use Open files." : cause instanceof Error ? cause.message : "Unable to open that URL.";
  } finally { button.disabled = false; button.textContent = "Open document"; }
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
  void setupPwa();
}

start().catch((error) => { saveStatus.textContent = error instanceof Error ? error.message : "Unable to open the workspace. Reload to try again."; });
