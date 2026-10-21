import { ApiError, request } from "./cloud.ts";
import { diffLines, snippet } from "../src/diff.ts";
import * as history from "./history.ts";

/**
 * The History dialog for a file on this device: its versions newest first, each with
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

export async function showHistory(path: string, restore: (source: string) => void, topUp: () => void): Promise<void> {
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
    const snapshots = await history.list(path);
    list.replaceChildren();
    if (!snapshots.length) {
      list.append(el("p", "history-empty", "No versions yet. A version is kept each time this file is opened from disk, saved, or changes on disk."));
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
      if (older && !snapshot.summary && billing?.enabled) {
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
      if (index > 0) {
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

/** Choose an amount, then pay with any coin or PayPal on CoinPay's page; the balance arrives by webhook. */
export async function showTopUp(): Promise<void> {
  let billing: Account & { topups: boolean; packs: number[] };
  try { billing = await request("billing"); }
  catch { location.href = `/account?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
  const box = document.createElement("dialog");
  box.className = "history-dialog topup-dialog";
  box.setAttribute("aria-label", "Add funds");
  const per = billing.multiplier === 2 ? "twice" : `${billing.multiplier} times`;
  box.innerHTML = `<div class="dialog-header"><h2>Add funds</h2><button type="button" aria-label="Close">×</button></div>
    <p>Pay as you go, from one balance that never expires: storage over the free 5 GB is $0.05 per GB a month, and each AI summary costs ${per} what the AI call costs us, usually a fraction of a cent.</p>
    <p class="history-account">Balance ${dollars(billing.balanceMicros)}</p>
    <form><div class="topup-packs"></div><p class="history-account">Pay with BTC, ETH, SOL, USDC, USDT and more, or PayPal, on CoinPay.</p>
    <p class="history-error" role="alert"></p><button class="primary-action" type="submit">Continue to CoinPay</button></form>`;
  const packs = box.querySelector(".topup-packs")!;
  billing.packs.forEach((usd, index) => {
    const label = el("label", "topup-pack");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "amount";
    input.value = String(usd);
    input.checked = index === 1;
    label.append(input, ` $${usd}`);
    packs.append(label);
  });
  const error = box.querySelector<HTMLElement>(".history-error")!;
  const form = box.querySelector("form")!;
  if (!billing.topups) { error.textContent = "Top-ups open soon."; form.querySelector("button")!.disabled = true; }
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const submit = form.querySelector("button")!;
    submit.disabled = true;
    try {
      const created = await request<{ payUrl: string }>("billing/topups", "POST", { amountUsd: Number(data.get("amount")) });
      location.href = created.payUrl;
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Could not start the payment.";
      submit.disabled = false;
    }
  };
  box.querySelector<HTMLButtonElement>(".dialog-header button")!.onclick = () => box.close();
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
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
