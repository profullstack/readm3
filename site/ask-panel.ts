import { ApiError, request } from "./cloud.ts";
import { dollars, el } from "./history-panel.ts";
import { aiDialog, listenControl, signInLine, topUpButton } from "./ai-dialog.ts";
import { binaryType } from "../src/code.ts";
import type { Document } from "./workspace.ts";

/**
 * Ask AI (readm3.com/talk): a conversation with the model about your own files, the open
 * one, a folder it is in, or the whole workspace. Only text goes (a PDF, an image or a
 * file stored apart is left out and counted), up to 400 KB of it per question. Signed in,
 * the first 10 questions each day are free (server/billing.ts FREE_QUESTIONS_PER_DAY),
 * then each is paid from the prepaid balance; admins are never charged. Every answer can
 * be read aloud with Listen, like a summary (site/ai-dialog.ts).
 */
interface FreeQuestions { perDay: number; left: number; resetsAt: string; }
interface Answered { answer: string; summaryId?: string; listen?: boolean; chargedMicros: number; free: boolean; exempt?: boolean; freeQuestions: FreeQuestions; balanceMicros: number; }
type Turn = { question: string; answer: string };

const MAX_TEXT = 400 * 1024;
const MAX_FILES = 500;

/** The folders holding `path`, nearest first: "a/b/c.md" is in "a/b", then "a". */
function folders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("/"));
}

/** The text files under a scope ("" = everything), as much as one question carries. */
export function gather(documents: Document[], scope: { file?: string; folder?: string }) {
  const chosen = documents.filter((doc) => scope.file !== undefined ? doc.path === scope.file
    : !scope.folder || doc.path.startsWith(`${scope.folder}/`));
  const files: { path: string; text: string }[] = [];
  let size = 0;
  let skipped = 0;
  for (const doc of chosen) {
    if (doc.blob || binaryType(doc.path) || !doc.source.trim() || files.length >= MAX_FILES || size + doc.source.length > MAX_TEXT) { skipped++; continue; }
    files.push({ path: doc.path, text: doc.source });
    size += doc.source.length;
  }
  return { files, skipped };
}

const freeLine = (free: FreeQuestions) => free.left > 0
  ? `${free.left} of ${free.perDay} free questions left today`
  : `Today's ${free.perDay} free questions are used; more at midnight UTC`;

export async function showAsk(documents: () => Document[], active: string, topUp: () => void): Promise<void> {
  const box = aiDialog("ask-dialog", "ask-title", "Ask AI about your files", "Close Ask AI");
  box.insertAdjacentHTML("beforeend", `<label class="ask-scope">Ask about <select id="ask-scope"></select></label>
<div class="summary-body ask-log" aria-live="polite"></div>
<form class="ask-form"><textarea id="ask-question" rows="3" placeholder="What does this say about…? Where is… set? Summarize the decisions in this folder." aria-label="Your question"></textarea><button type="submit" class="primary">Ask</button></form>
<p class="history-account"></p>`);
  const log = box.querySelector<HTMLElement>(".ask-log")!;
  const account = box.querySelector<HTMLElement>(".history-account")!;
  const select = box.querySelector<HTMLSelectElement>("#ask-scope")!;
  const form = box.querySelector<HTMLFormElement>(".ask-form")!;
  const input = box.querySelector<HTMLTextAreaElement>("#ask-question")!;
  const submit = form.querySelector<HTMLButtonElement>("button")!;

  const scopes: { label: string; scope: { file?: string; folder?: string } }[] = [
    { label: `This file · ${active.split("/").at(-1)}`, scope: { file: active } },
    ...folders(active).map((folder) => ({ label: `Folder · ${folder}/`, scope: { folder } })),
    { label: "Whole workspace", scope: {} },
  ];
  for (const [i, { label }] of scopes.entries()) select.append(new Option(label, String(i)));
  // Each scope keeps its own conversation; changing scope starts a new one.
  const turns = new Map<number, (Turn & { summaryId?: string })[]>();
  let listen = false;
  /** One answer on screen, with Listen when the server has a voice. */
  const answerBlock = (answer: string, summaryId?: string) => {
    const block = el("div", "ask-answer");
    block.append(el("p", "summary-text", answer));
    if (listen && summaryId) block.append(listenControl(summaryId, "Listen to this answer", box, topUp));
    return block;
  };
  const say = (message: string) => log.replaceChildren(el("p", "history-empty", message));
  const describe = () => {
    const { files, skipped } = gather(documents(), scopes[Number(select.value)]!.scope);
    const past = turns.get(Number(select.value)) ?? [];
    log.replaceChildren();
    for (const turn of past) log.append(el("p", "ask-question", turn.question), answerBlock(turn.answer, turn.summaryId));
    if (!past.length) say(files.length
      ? `${files.length.toLocaleString()} file${files.length === 1 ? "" : "s"} will be read${skipped ? ` (${skipped.toLocaleString()} left out: not text, too large, or past 400 KB)` : ""}. Ask anything about ${files.length === 1 ? "it" : "them"}.`
      : "There is no text to ask about here. Pick a folder or the whole workspace.");
  };
  select.onchange = () => { describe(); input.focus(); };
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });

  say("Loading…");
  let billing: { enabled?: boolean; freeQuestions?: FreeQuestions; exempt?: boolean; balanceMicros: number } | null = null;
  try { billing = await request("billing"); } catch { billing = null; }
  if (!billing) {
    log.replaceChildren(signInLine("to ask AI about your files: 10 questions a day free, then pay as you go.", "/talk"));
    form.hidden = true;
    return;
  }
  if (!billing.enabled) { say("Ask AI is not available on this server yet."); form.hidden = true; return; }
  account.textContent = billing.exempt ? "Admin, no charges" : billing.freeQuestions ? freeLine(billing.freeQuestions) : "";
  describe();
  input.focus();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || submit.disabled) return;
    const index = Number(select.value);
    const { files, skipped } = gather(documents(), scopes[index]!.scope);
    if (!files.length) { say("There is no text to ask about here. Pick a folder or the whole workspace."); return; }
    const past = turns.get(index) ?? [];
    if (!past.length) log.replaceChildren();
    const pending = el("p", "history-empty", "Thinking…");
    log.append(el("p", "ask-question", question), pending);
    input.value = "";
    submit.disabled = true;
    try {
      const result = await request<Answered>("ask", "POST", { question, files, skipped, history: past.map(({ question, answer }) => ({ question, answer })) });
      listen = !!result.listen;
      pending.replaceWith(answerBlock(result.answer, result.summaryId));
      turns.set(index, [...past, { question, answer: result.answer, summaryId: result.summaryId }]);
      const cost = result.exempt ? "Admin, no charge" : result.free ? "Free" : dollars(result.chargedMicros);
      account.textContent = result.exempt ? cost : `${cost} · ${freeLine(result.freeQuestions)} · balance ${dollars(result.balanceMicros)}`;
    } catch (error) {
      pending.textContent = error instanceof Error ? error.message : "The question failed.";
      input.value = question;
      if (error instanceof ApiError && error.status === 402) account.replaceChildren(topUpButton(box, topUp));
    } finally {
      submit.disabled = false;
      log.scrollTop = log.scrollHeight;
      input.focus();
    }
  };
}
