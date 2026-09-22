/**
 * The code view: a paste that is not Markdown, drawn as numbered, highlighted,
 * foldable lines. The highlighting and the fold regions come from src/code.ts; this
 * file only owns the DOM. Line numbers live in a CSS attribute so a drag-select of the
 * code never picks them up, and folding hides rows rather than rebuilding them, so a
 * 5,000-line file folds without re-rendering.
 */
import { foldRegions, formatForReading, highlightLines, type FoldRegion } from "../src/code.ts";

export interface CodeView {
  /** The text as displayed, which is the source unless minified JSON was pretty-printed. */
  text: string;
  formatted: boolean;
  lines: number;
  foldAll(): void;
  unfoldAll(): void;
  setWrap(on: boolean): void;
}

export function renderCode(container: HTMLElement, source: string, language: string): CodeView {
  const { text, formatted } = formatForReading(language, source);
  const html = highlightLines(text, language);
  if (text.endsWith("\n")) html.pop();
  const plain = text.split("\n");
  if (text.endsWith("\n")) plain.pop();
  const regions = foldRegions(plain);
  const regionAt = new Map<number, FoldRegion>(regions.map((region) => [region.start, region]));
  const folded = new Set<number>();

  container.replaceChildren();
  container.dataset.language = language;
  container.style.setProperty("--gutter-digits", String(String(html.length).length));
  const rows: HTMLElement[] = [];
  const markers = new Map<number, HTMLElement>();
  for (let index = 0; index < html.length; index++) {
    const row = document.createElement("div");
    row.className = "code-line";
    const gutter = document.createElement("span");
    gutter.className = "code-gutter";
    gutter.dataset.line = String(index + 1);
    const region = regionAt.get(index);
    if (region) {
      const button = document.createElement("button");
      button.className = "fold";
      button.type = "button";
      button.setAttribute("aria-expanded", "true");
      button.setAttribute("aria-label", `Fold lines ${index + 2} to ${region.end + 1}`);
      button.textContent = "▾";
      button.addEventListener("click", () => toggle(index));
      gutter.append(button);
    }
    const code = document.createElement("code");
    code.className = "code-text";
    code.innerHTML = html[index]!;
    row.append(gutter, code);
    if (region) {
      const marker = document.createElement("button");
      marker.className = "fold-marker";
      marker.type = "button";
      marker.hidden = true;
      marker.addEventListener("click", () => toggle(index));
      row.append(marker);
      markers.set(index, marker);
    }
    rows.push(row);
    container.append(row);
  }

  function toggle(start: number) {
    if (folded.has(start)) folded.delete(start); else folded.add(start);
    apply();
    rows[start]!.querySelector<HTMLButtonElement>(".fold")?.focus();
  }

  /** Recomputes visibility from the set of folded starts, so nested folds compose. */
  function apply() {
    const hidden = new Uint8Array(rows.length);
    for (const start of folded) {
      const region = regionAt.get(start)!;
      hidden.fill(1, start + 1, region.end + 1);
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      row.hidden = hidden[index] === 1;
      const marker = markers.get(index);
      if (!marker) continue;
      const isFolded = folded.has(index);
      const region = regionAt.get(index)!;
      row.classList.toggle("folded", isFolded);
      row.querySelector<HTMLButtonElement>(".fold")!.setAttribute("aria-expanded", String(!isFolded));
      row.querySelector<HTMLButtonElement>(".fold")!.textContent = isFolded ? "▸" : "▾";
      marker.hidden = !isFolded;
      if (isFolded) {
        const closing = plain[region.end]!.trim();
        const count = region.end - index;
        marker.textContent = `⋯ ${count} line${count === 1 ? "" : "s"}${/^[\]})>]+[,;]?$/.test(closing) ? ` ${closing}` : ""}`;
        marker.setAttribute("aria-label", `Unfold ${count} lines`);
      }
    }
  }

  return {
    text,
    formatted,
    lines: html.length,
    foldAll() { for (const region of regions) folded.add(region.start); apply(); },
    unfoldAll() { folded.clear(); apply(); },
    setWrap(on) { container.classList.toggle("wrap", on); },
  };
}
