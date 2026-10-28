import { ApiError, request } from "./cloud.ts";
import { dollars, el, type Account } from "./history-panel.ts";
import { aiDialog, listenControl, signInLine, topUpButton } from "./ai-dialog.ts";
import { toBase64 } from "./workspace.ts";

/**
 * The Summarize dialog: an AI abstract and key points of the open document, text or
 * file. Signed in, the first few each week are free (server/billing.ts
 * FREE_DOCUMENTS_PER_WEEK), then each one is paid from the prepaid balance. The server
 * keeps every summary for the account, so a document summarized once is answered from
 * that copy (on any device, after a reload) with no new call and no charge.
 *
 * Listen (site/ai-dialog.ts) reads a summary aloud when the server has a voice.
 *
 * A PDF or image is sent as it is for the model to read; an office document or e-book is
 * sent as it is and the server reads the text out of it. An image the models cannot
 * take (SVG, AVIF, BMP, an icon, or one too large) is redrawn as PNG or JPEG here first.
 */
interface Free { perWeek: number; left: number; resetsAt: string; }
interface Summarized { summary: string; summaryId?: string; cached?: boolean; listen?: boolean; chargedMicros: number; free: boolean; freeSummaries: Free; balanceMicros: number; }

const done = new Map<string, Summarized>();
const MAX_TEXT = 400 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_IMAGE = 3_750_000;
const MAX_SIDE = 2_000;
const MODEL_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** What to summarize: the text as it reads now, or a file (fetched only once the dialog needs it). */
export type SummarySource = { text: string } | { mime: string; size: number; file: () => Promise<Blob> };

const canvasBlob = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("This image could not be converted.")), type, 0.85));

/** An image as the models take it: PNG, JPEG, GIF or WebP, at most 2,000 px a side and 3.75 MB. */
async function forModel(blob: Blob, mime: string): Promise<{ blob: Blob; mime: string }> {
  if (!mime.startsWith("image/")) return { blob, mime };
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error("This image could not be read."); });
    // An SVG with no width or height has no natural size; draw it at a readable one.
    const width = image.naturalWidth || 1_024;
    const height = image.naturalHeight || 1_024;
    if (MODEL_IMAGES.includes(mime) && blob.size <= MAX_IMAGE && Math.max(width, height) <= MAX_SIDE) return { blob, mime };
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await canvasBlob(canvas, "image/png");
    if (png.size <= MAX_IMAGE) return { blob: png, mime: "image/png" };
    // A photo too large as PNG goes as JPEG, on white where it was transparent.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return { blob: await canvasBlob(canvas, "image/jpeg"), mime: "image/jpeg" };
  } finally { URL.revokeObjectURL(url); }
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const freeLine = (free: Free) => free.left > 0
  ? `${free.left} of ${free.perWeek} free summaries left this week`
  : `This week's ${free.perWeek} free summaries are used; more start ${new Date(free.resetsAt).toLocaleDateString(undefined, { weekday: "long" })}`;

export async function showSummary(path: string, source: SummarySource, topUp: () => void): Promise<void> {
  const box = aiDialog("", "summary-title", `Summary · ${path.split("/").at(-1)}`, "Close summary");
  const body = el("div", "summary-body");
  const account = el("p", "history-account");
  box.append(body, account);

  const say = (message: string) => body.replaceChildren(el("p", "history-empty", message));
  const show = (result: Summarized, again = false) => {
    body.replaceChildren(el("p", "summary-text", result.summary));
    const cost = again || result.cached ? "Saved summary, no charge" : result.free ? "Free" : dollars(result.chargedMicros);
    account.replaceChildren(`${cost} · ${freeLine(result.freeSummaries)} · balance ${dollars(result.balanceMicros)}`);
    if (result.listen && result.summaryId) body.append(listenControl(result.summaryId, "Listen to this summary", box, topUp));
  };
  let key = "text" in source ? `${path}\n${source.text}` : "";
  const cached = done.get(key);
  if (cached) { show(cached, true); return; }
  if ("text" in source && !source.text.trim()) { say("This document is empty."); return; }
  if ("text" in source && source.text.length > MAX_TEXT) { say("Summaries take documents up to 400 KB."); return; }
  if (!("text" in source) && source.size > MAX_FILE) { say("Summaries read files up to 20 MB."); return; }

  say("Loading…");
  let billing: (Account & { freeSummaries?: Free }) | null = null;
  try { billing = await request("billing"); } catch { billing = null; }
  if (!billing) { body.replaceChildren(signInLine("to summarize documents with AI: 10 a week free, then pay as you go.")); return; }
  if (!billing.enabled) { say("AI summaries are not available on this server yet."); return; }

  let payload: Record<string, unknown> = { path, text: "text" in source ? source.text : "" };
  if (!("text" in source)) {
    say("Reading the file…");
    try {
      const prepared = await forModel(await source.file(), source.mime);
      const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
      key = `${path}\n${await digest(bytes)}`;
      payload = { path, mime: prepared.mime, data: toBase64(bytes) };
    } catch (error) {
      say(error instanceof Error ? error.message : "This file could not be read.");
      return;
    }
    const again = done.get(key);
    if (again) { show(again, true); return; }
  }

  say("Summarizing…");
  if (billing.freeSummaries) account.textContent = freeLine(billing.freeSummaries);
  try {
    const result = await request<Summarized>("summaries/document", "POST", payload);
    done.set(key, result);
    show(result);
  } catch (error) {
    say(error instanceof Error ? error.message : "The summary failed.");
    if (error instanceof ApiError && error.status === 402) account.replaceChildren(topUpButton(box, topUp));
  }
}
