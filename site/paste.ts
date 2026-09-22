/**
 * readm3.com/paste: make a paste, open one, and see how the CLI, curl and MCP do it.
 *
 * A paste is text (or a PDF or image, sent as base64) behind a secret link with no
 * account. This page is the front door to that: a textarea that also takes a dropped
 * or chosen file, a name and expiry, and the link when it is made. Everything goes
 * through the same POST /api/v1/pastes the CLI uses.
 */
import { binaryType, detectLanguage, languageOf, looksBinary } from "../src/code.ts";
import { outputLink, request, showError } from "./cloud.ts";

const PASTE_MAX_BYTES = 256 * 1024;
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = element<HTMLFormElement>("paste-form");
const sourceInput = element<HTMLTextAreaElement>("paste-source");
const titleInput = element<HTMLInputElement>("paste-title");
const expiresInput = element<HTMLSelectElement>("paste-expires");
const fileInput = element<HTMLInputElement>("paste-file");
const meta = element("paste-meta");
const error = element("paste-error");
const submit = element<HTMLButtonElement>("paste-submit");
const result = element("paste-result");
const drop = element("paste-drop");
const encoder = new TextEncoder();
/** A chosen PDF or image: its base64 travels as the source while the textarea explains itself. */
let binary: { name: string; source: string; bytes: number } | null = null;

const formatBytes = (n: number) => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;

function describe() {
  if (binary) {
    meta.textContent = `${binary.name} (${formatBytes(binary.bytes)}) will be pasted as a file. Clear the box to start over.`;
    return;
  }
  const text = sourceInput.value;
  const bytes = encoder.encode(text).length;
  if (!text.trim()) { meta.textContent = "The language is detected from the name or the content. Up to 256 KB."; return; }
  const language = languageOf(detectLanguage(titleInput.value.trim() || undefined, text));
  meta.textContent = `${language.label} · ${formatBytes(bytes)}${bytes > PASTE_MAX_BYTES ? " · over the 256 KB limit" : ""}`;
}

function clearBinary() {
  if (!binary) return;
  binary = null;
  sourceInput.disabled = false;
  sourceInput.value = "";
  fileInput.value = "";
  describe();
}

async function takeFile(file: File) {
  error.textContent = "";
  const kind = binaryType(file.name);
  const cost = kind ? Math.ceil(file.size * 4 / 3) : file.size;
  if (cost > PASTE_MAX_BYTES) { error.textContent = `${file.name} is ${formatBytes(file.size)}; a paste holds 256 KB${kind ? " of base64" : ""}.`; return; }
  if (!titleInput.value.trim()) titleInput.value = file.name;
  if (kind) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let raw = "";
    for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    binary = { name: file.name, source: btoa(raw), bytes: file.size };
    sourceInput.value = `${file.name}\n${kind.label}, ${formatBytes(file.size)}. Click "Create private link" to paste it.`;
    sourceInput.disabled = true;
    describe();
    return;
  }
  const text = await file.text();
  if (looksBinary(text)) { error.textContent = `${file.name} is not a text file, PDF or image.`; return; }
  binary = null;
  sourceInput.disabled = false;
  sourceInput.value = text;
  describe();
}

function tokenOf(input: string): string | null {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/p\/([A-Za-z0-9_-]{43})(?:\/raw)?\/?$/)?.[1];
  if (fromUrl) return fromUrl;
  return /^[A-Za-z0-9_-]{43}$/.test(trimmed) ? trimmed : null;
}

function showResult(paste: { url: string; raw: string; title: string; language: string; expiresAt: string }) {
  form.hidden = true;
  result.hidden = false;
  result.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = `${paste.title} is pasted.`;
  const note = document.createElement("p");
  note.textContent = `Copy the link now. Only a hash of its secret is stored, so it cannot be shown again. It expires ${new Date(paste.expiresAt).toLocaleString()}. Anyone holding the link can read or delete the paste.`;
  result.append(heading, note);
  outputLink(result, paste.url);
  const actions = document.createElement("div");
  actions.className = "cta";
  const open = document.createElement("a");
  open.className = "ghost";
  open.href = paste.url;
  open.textContent = "Open it ↗";
  const raw = document.createElement("a");
  raw.className = "ghost";
  raw.href = paste.raw;
  raw.textContent = "Raw text";
  const again = document.createElement("button");
  again.className = "ghost";
  again.type = "button";
  again.textContent = "New paste";
  again.onclick = () => { result.hidden = true; form.hidden = false; clearBinary(); sourceInput.value = ""; titleInput.value = ""; describe(); sourceInput.focus(); };
  actions.append(open, raw, again);
  result.append(actions);
  const curl = document.createElement("pre");
  curl.className = "paste-curl";
  curl.textContent = `curl ${paste.raw}`;
  result.append(curl);
  history.replaceState(null, "", "/paste");
}

form.onsubmit = async (event) => {
  event.preventDefault();
  error.textContent = "";
  const source = binary ? binary.source : sourceInput.value;
  if (!source.trim()) { error.textContent = "Paste something first."; sourceInput.focus(); return; }
  if (encoder.encode(source).length > PASTE_MAX_BYTES) { error.textContent = "That is over the 256 KB limit for a paste."; return; }
  submit.disabled = true;
  submit.textContent = "Creating…";
  try {
    const paste = await request<{ url: string; raw: string; title: string; language: string; expiresAt: string }>("pastes", "POST", {
      source,
      title: binary ? binary.name : titleInput.value.trim() || undefined,
      expiresIn: expiresInput.value,
    });
    showResult(paste);
  } catch (cause) {
    showError(error, cause);
  } finally {
    submit.disabled = false;
    submit.textContent = "Create private link";
  }
};

sourceInput.oninput = () => { if (binary) clearBinary(); describe(); };
titleInput.oninput = describe;
fileInput.onchange = () => { const file = fileInput.files?.[0]; if (file) void takeFile(file); };
for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.add("over"); });
for (const type of ["dragleave", "drop"]) drop.addEventListener(type, (event) => { event.preventDefault(); drop.classList.remove("over"); });
drop.addEventListener("drop", (event) => { const file = event.dataTransfer?.files[0]; if (file) void takeFile(file); });
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !form.hidden) form.requestSubmit();
});

const openForm = element<HTMLFormElement>("open-form");
openForm.onsubmit = (event) => {
  event.preventDefault();
  const token = tokenOf(element<HTMLInputElement>("open-input").value);
  const openError = element("open-error");
  if (!token) { openError.textContent = "That is not a paste link. It looks like https://readm3.com/p/ followed by 43 characters."; return; }
  openError.textContent = "";
  location.href = `/p/${token}`;
};

// Arriving with text already in the URL (?text=) or a file name (?title=) pre-fills the box.
const params = new URLSearchParams(location.search);
if (params.get("text")) sourceInput.value = params.get("text")!;
if (params.get("title")) titleInput.value = params.get("title")!;
describe();
