import { ApiError, request } from "./cloud.ts";
import { dollars, el, type Account } from "./history-panel.ts";

/**
 * The Summarize dialog: an AI abstract and key points of the open document. Signed in,
 * the first few each week are free (server/billing.ts FREE_DOCUMENTS_PER_WEEK), then
 * each one is paid from the prepaid balance. A document summarized once is not sent
 * again while its text is unchanged, so pressing the button twice never charges twice.
 */
interface Free { perWeek: number; left: number; resetsAt: string; }
interface Summarized { summary: string; chargedMicros: number; free: boolean; freeSummaries: Free; balanceMicros: number; }

const done = new Map<string, Summarized>();
const MAX_TEXT = 400 * 1024;

const freeLine = (free: Free) => free.left > 0
  ? `${free.left} of ${free.perWeek} free summaries left this week`
  : `This week's ${free.perWeek} free summaries are used; more start ${new Date(free.resetsAt).toLocaleDateString(undefined, { weekday: "long" })}`;

export async function showSummary(path: string, text: string, topUp: () => void): Promise<void> {
  const box = document.createElement("dialog");
  box.className = "history-dialog summary-dialog";
  box.setAttribute("aria-labelledby", "summary-title");
  box.innerHTML = `<div class="dialog-header"><h2 id="summary-title"></h2><button type="button" aria-label="Close summary">×</button></div><div class="summary-body"></div><p class="history-account"></p>`;
  box.querySelector("h2")!.textContent = `Summary · ${path.split("/").at(-1)}`;
  const body = box.querySelector<HTMLElement>(".summary-body")!;
  const account = box.querySelector<HTMLElement>(".history-account")!;
  box.querySelector<HTMLButtonElement>(".dialog-header button")!.onclick = () => box.close();
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();

  const say = (message: string) => body.replaceChildren(el("p", "history-empty", message));
  const show = (result: Summarized, again = false) => {
    body.replaceChildren(el("p", "summary-text", result.summary));
    const cost = result.free ? "Free" : dollars(result.chargedMicros);
    account.replaceChildren(`${again ? "Already summarized" : cost} · ${freeLine(result.freeSummaries)} · balance ${dollars(result.balanceMicros)}`);
  };
  const key = `${path}\n${text}`;
  const cached = done.get(key);
  if (cached) { show(cached, true); return; }
  if (!text.trim()) { say("This document is empty."); return; }
  if (text.length > MAX_TEXT) { say("Summaries take documents up to 400 KB."); return; }

  say("Loading…");
  let billing: (Account & { freeSummaries?: Free }) | null = null;
  try { billing = await request("billing"); } catch { billing = null; }
  if (!billing) {
    const link = el("a", undefined, "Sign in (free)");
    link.href = `/account?next=${encodeURIComponent(location.pathname + location.search)}`;
    const line = el("p");
    line.append(link, " to summarize documents with AI: 10 a week free, then pay as you go.");
    body.replaceChildren(line);
    return;
  }
  if (!billing.enabled) { say("AI summaries are not available on this server yet."); return; }

  say("Summarizing…");
  if (billing.freeSummaries) account.textContent = freeLine(billing.freeSummaries);
  try {
    const result = await request<Summarized>("summaries/document", "POST", { path, text });
    done.set(key, result);
    show(result);
  } catch (error) {
    say(error instanceof Error ? error.message : "The summary failed.");
    if (error instanceof ApiError && error.status === 402) {
      const top = el("button", "ghost", "Top up");
      top.type = "button";
      top.onclick = () => { box.close(); topUp(); };
      account.replaceChildren(top);
    }
  }
}
