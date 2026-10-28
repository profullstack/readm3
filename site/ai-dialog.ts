import { ApiError } from "./cloud.ts";
import { dollars, el } from "./history-panel.ts";

/**
 * What the AI dialogs share (Summarize in site/summary-panel.ts, Ask AI in
 * site/ask-panel.ts): the dialog shell, the sign-in line, the Top up button, and Listen.
 *
 * Listen reads a kept summary or answer aloud when the server has a voice (ElevenLabs):
 * the first listen is paid from the balance (admins never pay), then the audio is kept
 * on the account and replays free; this session also keeps it, so a replay makes no
 * request at all.
 */
const heard = new Map<string, string>();

/** A kept summary or answer read aloud: an MP3 from the server, or the reason it could not be had. */
async function speech(summaryId: string): Promise<{ url: string; chargedMicros: number }> {
  const known = heard.get(summaryId);
  if (known) return { url: known, chargedMicros: 0 };
  const response = await fetch(`/api/v1/summaries/${encodeURIComponent(summaryId)}/speech`, { method: "POST", credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(data.error || `Listening failed (${response.status})`, response.status);
  }
  const url = URL.createObjectURL(await response.blob());
  heard.set(summaryId, url);
  return { url, chargedMicros: Number(response.headers.get("x-charged-micros") ?? 0) };
}

/** A modal with a title, a close button and a body; it removes itself when closed. */
export function aiDialog(className: string, id: string, title: string, closeLabel: string) {
  const box = document.createElement("dialog");
  box.className = `history-dialog summary-dialog ${className}`;
  box.setAttribute("aria-labelledby", id);
  box.innerHTML = `<div class="dialog-header"><h2 id="${id}"></h2><button type="button"></button></div>`;
  box.querySelector("h2")!.textContent = title;
  const close = box.querySelector<HTMLButtonElement>(".dialog-header button")!;
  close.textContent = "×";
  close.setAttribute("aria-label", closeLabel);
  close.onclick = () => box.close();
  box.addEventListener("click", (event) => { if (event.target === box) box.close(); });
  box.addEventListener("close", () => box.remove());
  document.body.append(box);
  box.showModal();
  return box;
}

/** "Sign in (free) to …", returning here afterwards. */
export function signInLine(what: string, next = location.pathname + location.search): HTMLElement {
  const link = el("a", undefined, "Sign in (free)");
  link.href = `/account?next=${encodeURIComponent(next)}`;
  const line = el("p");
  line.append(link, ` ${what}`);
  return line;
}

/** Top up: closes the dialog and opens Add funds. */
export function topUpButton(box: HTMLDialogElement, topUp: () => void): HTMLButtonElement {
  const top = el("button", "ghost", "Top up");
  top.type = "button";
  top.onclick = () => { box.close(); topUp(); };
  return top;
}

/** The Listen button for a kept summary or answer; it becomes an audio player once played. */
export function listenControl(summaryId: string, label: string, box: HTMLDialogElement, topUp: () => void): HTMLElement {
  const player = el("div", "summary-listen");
  const listen = el("button", "ghost", heard.has(summaryId) ? "Play" : "Listen");
  listen.type = "button";
  listen.setAttribute("aria-label", label);
  const status = el("small");
  listen.onclick = async () => {
    listen.disabled = true;
    status.textContent = heard.has(summaryId) ? "" : "Preparing audio…";
    try {
      const audio = await speech(summaryId);
      const element = document.createElement("audio");
      element.controls = true;
      element.autoplay = true;
      element.src = audio.url;
      status.textContent = audio.chargedMicros ? `Listen · ${dollars(audio.chargedMicros)} · replays are free` : "";
      player.replaceChildren(element, status);
    } catch (error) {
      listen.disabled = false;
      status.textContent = error instanceof Error ? error.message : "Listening failed.";
      if (error instanceof ApiError && error.status === 402) player.append(" ", topUpButton(box, topUp));
    }
  };
  player.append(listen, " ", status);
  return player;
}
