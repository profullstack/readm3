import { ApiError, request } from "./cloud.ts";
import { diffLines, snippet } from "../src/diff.ts";
import * as history from "./history.ts";
import * as cloudHistory from "./cloud-history.ts";

/**
 * The History dialog for a file: its versions newest first, from this device and from
 * the account (every device that synced it, site/cloud-history.ts), each with
 * when and why it was recorded, how much changed against the one before, the changed
 * lines themselves, and an AI abstract on request (prepaid, through CoinPay).
 */
export interface Account { balanceMicros: number; arm: string; multiplier: number; enabled: boolean; }
interface Summarized { summary: string; chargedMicros: number; arm: string; balanceMicros: number; }

export const dollars = (micros: number) => `$${(micros / 1e6).toFixed(micros !== 0 && Math.abs(micros) < 10_000 ? 4 : 2)}`;
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let dialog: HTMLDialogElement | undefined;

type Entry = Omit<history.Snapshot, "reason"> & { reason: string; cloud?: boolean };

/** Both histories in one list, newest first, without a version repeated next to itself. */
export function combine(local: history.Snapshot[], cloud: cloudHistory.CloudVersion[]): Entry[] {
  const all: Entry[] = [...local, ...cloud.map((version) => ({ id: version.id, at: version.at, reason: `synced from ${version.device}`, source: version.source, cloud: true }))];
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(!!a.cloud) - Number(!!b.cloud));
  return all.filter((entry, index) => index === 0 || entry.source !== all[index - 1]!.source);
}

/** `writable`: false where the file cannot be changed (read-only), so no version can be restored. */
export async function showHistory(path: string, restore: (source: string) => void, topUp: () => void, writable = true): Promise<void> {
  dialog ??= build();
  const title = dialog.querySelector("h2")!;
  const account = dialog.querySelector<HTMLElement>(".history-account")!;
  const list = dialog.querySelector<HTMLElement>(".history-list")!;
  title.textContent = `History · ${path.split("/").at(-1)}`;
  list.replaceChildren(el("p", "history-empty", "Loading…"));
  dialog.showModal();

  let billing: Account | null = null;
  try { billing = await request<Account>("billing"); } catch { billing = null; }
  const paint = async () => {
    account.replaceChildren();
    if (!billing) {
      const link = el("a", undefined, "Sign in");
      link.href = `/account?next=${encodeURIComponent(location.pathname + location.search)}`;
      account.append(link, " to add AI summaries of each change (pay as you go, through CoinPay).");
    } else if (!billing.enabled) {
      account.append("AI summaries are not available on this server yet.");
    } else {
      const top = el("button", "ghost", "Top up");
      top.type = "button";
      top.onclick = topUp;
      account.append(`AI summaries · balance ${dollars(billing.balanceMicros)} · `, top);
    }
    const [local, cloud] = await Promise.all([history.list(path), cloudHistory.list(path)]);
    const snapshots = combine(local, cloud);
    list.replaceChildren();
    if (!snapshots.length) {
      list.append(el("p", "history-empty", "No versions yet. A version is kept each time this file is opened from disk, saved, changes on disk, or syncs to your account."));
      return;
    }
    snapshots.forEach((snapshot, index) => {
      const older = snapshots[index + 1];
      const item = el("article", "history-item");
      const head = el("header");
      head.append(el("time", undefined, new Date(snapshot.at).toLocaleString()), el("span", "history-reason", snapshot.reason));
      const diff = older ? diffLines(older.source, snapshot.source) : null;
      head.append(el("span", "history-stat", diff ? `+${diff.added} −${diff.removed}` : "first version"));
      item.append(head);
      if (snapshot.summary) item.append(el("p", "history-summary", snapshot.summary.text));
      if (diff) {
        const lines = snippet(diff, 8);
        if (lines.length) {
          const pre = el("pre", "history-snippet");
          for (const line of lines) pre.append(el("span", line.startsWith("+") ? "added" : "removed", `${line}\n`));
          item.append(pre);
        }
      }
      const actions = el("div", "history-actions");
      if (older && !snapshot.cloud && !snapshot.summary && billing?.enabled) {
        const summarize = el("button", "ghost", "Summarize with AI");
        summarize.type = "button";
        summarize.onclick = async () => {
          summarize.disabled = true;
          summarize.textContent = "Summarizing…";
          try {
            const result = await request<Summarized>("summaries", "POST", { path, before: older.source, after: snapshot.source });
            await history.setSummary(path, snapshot.id, { text: result.summary, costMicros: result.chargedMicros, arm: result.arm, at: new Date().toISOString() });
            billing = { ...billing!, balanceMicros: result.balanceMicros };
            await paint();
          } catch (error) {
            summarize.disabled = false;
            summarize.textContent = "Summarize with AI";
            const message = error instanceof ApiError && error.status === 402 ? `${error.message}` : error instanceof Error ? error.message : "The summary failed.";
            actions.append(el("span", "history-error", message));
            if (error instanceof ApiError && error.status === 402) { const top = el("button", "ghost", "Top up"); top.type = "button"; top.onclick = topUp; actions.append(top); }
          }
        };
        actions.append(summarize);
      }
      if (index > 0 && writable) {
        const back = el("button", "ghost", "Restore");
        back.type = "button";
        back.onclick = () => { restore(snapshot.source); dialog!.close(); };
        actions.append(back);
      }
      if (snapshot.summary) actions.append(el("small", undefined, `AI summary · ${dollars(snapshot.summary.costMicros)}`));
      item.append(actions);
      list.append(item);
    });
  };
  await paint();
}

/**
 * Add funds is its own page, /checkout (server/checkout.ts): choose an amount there, pay
 * with any coin or PayPal on CoinPay's page, and the balance arrives by webhook.
 * `source` says which part of the app sent the buyer.
 */
export function openCheckout(source: string): void {
  location.href = `/checkout?source=${encodeURIComponent(source)}`;
}

/** Back from CoinPay with ?topup=<id>: wait for the webhook, then say what the balance is. */
export async function awaitTopUp(topupId: string, say: (message: string) => void): Promise<void> {
  say("Waiting for CoinPay to confirm your payment…");
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const status = await request<{ status: string; balanceMicros: number }>(`billing/topups/${encodeURIComponent(topupId)}`);
      if (status.status === "paid") { say(`Payment confirmed. Your balance is ${dollars(status.balanceMicros)}.`); return; }
    } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  say("CoinPay has not confirmed the payment yet. Your balance updates as soon as it does.");
}

function build(): HTMLDialogElement {
  const box = document.createElement("dialog");
  box.id = "file-history-dialog";
  box.className = "history-dialog";
  box.setAttribute("aria-labelledby", "file-history-title");
  box.innerHTML = `<div class="dialog-header"><h2 id="file-history-title">History</h2><button type="button" aria-label="Close history">×</button></div><p class="history-account"></p><div class="history-list"></div>`;
  box.querySelector<HTMLButtonElement>(".dialog-header button")!.onclick = () => box.close();
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  document.body.append(box);
  return box;
}
