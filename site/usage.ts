/**
 * The usage meter in the editor's header: files and storage against the plan's limits.
 * Signed out it measures this device's workspace (1,000 files, 20 MB); signed in it
 * measures the account (5,000 files, 5 GB stored free, then pay as you go). A click
 * opens the limits, the price, the balance and a way to add funds or sign in.
 */
import { modal } from "./cloud.ts";
import * as stored from "./blobs.ts";
import { showTopUp } from "./history-panel.ts";
import { formatStorage, FREE_STORAGE_BYTES, MAX_ACCOUNT_FILES, MAX_BLOB_BYTES, STORAGE_MICROS_PER_GIB_MONTH } from "../src/blob-store.ts";

export const LOCAL_FILES = 1000;
export const LOCAL_BYTES = 20 * 1024 * 1024;
const LOCAL_FILE_BYTES = 4 * 1024 * 1024;

export interface LocalUsage { files: number; bytes: number; signedIn: boolean }

let account: stored.StorageAccount | null = null;
let fetchedAt = 0;
let last: LocalUsage = { files: 0, bytes: 0, signedIn: false };

const dollars = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;
const count = (n: number) => n.toLocaleString();

/** Redraws the meter; the account's numbers are fetched at most every 30 s unless forced. */
export async function refreshUsage(local: LocalUsage, force = false) {
  last = local;
  if (!local.signedIn) account = null;
  else if (force || !account || Date.now() - fetchedAt > 30_000) {
    fetchedAt = Date.now();
    try { account = await stored.account(); } catch { /* Offline: the last numbers stand. */ }
  }
  paint();
}

function numbers() {
  if (last.signedIn) {
    const used = account?.usedBytes ?? 0;
    const free = account?.freeBytes ?? FREE_STORAGE_BYTES;
    return { files: last.files, fileLimit: MAX_ACCOUNT_FILES, used, limit: free, over: used > free };
  }
  return { files: last.files, fileLimit: LOCAL_FILES, used: last.bytes, limit: LOCAL_BYTES, over: false };
}

function paint() {
  const button = document.getElementById("usage");
  if (!button) return;
  const n = numbers();
  const share = Math.min(1, Math.max(n.used / n.limit, n.files / n.fileLimit));
  const text = `${formatStorage(n.used)} / ${formatStorage(n.limit)} · ${count(n.files)} / ${count(n.fileLimit)} files`;
  button.hidden = false;
  button.classList.toggle("near", share >= 0.8 && !n.over);
  button.classList.toggle("over", n.over || share >= 1);
  button.title = n.over ? `${text} · over the free storage, pay as you go` : text;
  button.setAttribute("aria-label", `Usage and limits: ${button.title}`);
  const bar = button.querySelector<HTMLElement>(".usage-fill");
  // Anything in use shows at least a sliver, so an empty bar means an empty workspace.
  if (bar) bar.style.width = `${share > 0 ? Math.max(4, Math.round(share * 100)) : 0}%`;
  const label = button.querySelector<HTMLElement>(".usage-text");
  if (label) label.textContent = n.over ? `${formatStorage(n.used)} · pay as you go` : text;
}

export function showUsage() {
  const n = numbers();
  const box = modal("Usage and limits");
  const rows: [string, string][] = last.signedIn ? [
    ["Plan", n.over || (account?.balanceMicros ?? 0) > 0 ? "Free account, pay as you go" : "Free account"],
    ["Files", `${count(n.files)} of ${count(n.fileLimit)}`],
    ["Stored files", `${formatStorage(n.used)} of ${formatStorage(n.limit)} free`],
    ["Largest file", formatStorage(account?.maxFileBytes ?? MAX_BLOB_BYTES)],
    ["Over the free storage", `${dollars(account?.microsPerGibMonth ?? STORAGE_MICROS_PER_GIB_MONTH)} per GB a month`],
    ["Balance", account ? dollars(account.balanceMicros) : "unavailable offline"],
  ] : [
    ["Plan", "No account: this device only"],
    ["Files", `${count(n.files)} of ${count(n.fileLimit)}`],
    ["Workspace", `${formatStorage(n.used)} of ${formatStorage(n.limit)}`],
    ["Largest file", formatStorage(LOCAL_FILE_BYTES)],
  ];
  const table = document.createElement("dl");
  table.className = "usage-table";
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    table.append(dt, dd);
  }
  const note = document.createElement("p");
  note.textContent = last.signedIn
    ? "Files over 4 MB are stored end-to-end encrypted on your account. Storage over the free allowance is charged hourly from your balance; with no balance, new uploads past it wait, and nothing stored is deleted."
    : "A free account raises the limits to 5,000 files of up to 5 GB each, with 5 GB of encrypted storage that syncs to every device.";
  const actions = document.createElement("p");
  if (last.signedIn) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "primary";
    add.textContent = "Add funds";
    add.onclick = () => { box.close(); void showTopUp(); };
    actions.append(add);
  } else {
    const link = document.createElement("a");
    link.className = "primary";
    link.href = `/account?next=${encodeURIComponent("/viewer")}`;
    link.textContent = "Sign in (free)";
    actions.append(link);
  }
  box.body.append(table, note, actions);
}
