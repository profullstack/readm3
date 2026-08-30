/**
 * A small markdown renderer that produces styled lines instead of a DOM.
 *
 * Spans carry a semantic `role` rather than a color; the viewer maps roles onto
 * the active HQTUI theme. That split keeps this file pure and testable without
 * a terminal, and lets a theme change re-color a document without re-parsing it.
 */
import { stringWidth } from "@profullstack/hqtui";

export type Role =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "code"
  | "fence"
  | "gutter"
  | "lang"
  | "link"
  | "url"
  | "quote"
  | "bullet"
  | "rule"
  | "meta"
  | "th";

export interface Span {
  text: string;
  role?: Role;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

export interface Line {
  spans: Span[];
}

type Style = Omit<Span, "text">;

const BULLETS = ["•", "◦", "▪", "·"];
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```+|~~~+)[ \t]*([\w+#.-]*)/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const TASK = /^\[([ xX])\][ \t]+/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|/;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t)(.*)$/;

/** The visible text of a line, with all styling dropped. Handy in tests. */
export function plain(line: Line): string {
  return line.spans.map((s) => s.text).join("");
}

/** Every line as plain text. */
export function toText(lines: Line[]): string[] {
  return lines.map(plain);
}

// --------------------------------------------------------------- inline

function matchLink(src: string): { text: string; href: string; length: number } | null {
  if (src[0] !== "[") return null;
  let depth = 0;
  let i = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || i >= src.length) return null;
  const text = src.slice(1, i);
  const rest = src.slice(i + 1);
  const inline = /^\([ \t]*(<[^>]*>|[^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:[ \t]+["'(][^\n]*?["')])?[ \t]*\)/.exec(rest);
  if (inline) {
    const href = (inline[1] ?? "").replace(/^<|>$/g, "");
    return { text, href, length: i + 1 + inline[0].length };
  }
  const ref = /^\[([^\]]*)\]/.exec(rest);
  if (ref) return { text, href: ref[1] ?? "", length: i + 1 + ref[0].length };
  return null;
}

/**
 * Emphasis closers must not sit against a space, and `_` must not fire inside a
 * word — otherwise every snake_case identifier in a README turns italic.
 */
function findClose(src: string, from: number, marker: string): number {
  let j = from;
  while (j < src.length) {
    const k = src.indexOf(marker, j);
    if (k < 0) return -1;
    if (k === from || /\s/.test(src[k - 1] ?? "")) {
      j = k + marker.length;
      continue;
    }
    if (marker[0] === "_" && /[\w]/.test(src[k + marker.length] ?? "")) {
      j = k + marker.length;
      continue;
    }
    return k;
  }
  return -1;
}

/**
 * Fold the HTML that real READMEs are full of back into markdown.
 *
 * Inline code is held out of this: `Array<string>` must survive tag stripping.
 */
export function normalizeHtml(src: string): string {
  return src
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : stripTags(part)))
    .join("");
}

function stripTags(src: string): string {
  return src
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<img\b[^>]*?alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) => `![${alt}]()`)
    .replace(/<img\b[^>]*?src=["']([^"']*)["'][^>]*>/gi, (_m, href: string) => `![${href}]()`)
    .replace(/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => `[${text}](${href})`)
    .replace(/<(?:code|kbd|tt|samp)>([\s\S]*?)<\/(?:code|kbd|tt|samp)>/gi, (_m, text: string) => `\`${text}\``)
    .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, text: string) => `**${text}**`)
    .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, (_m, text: string) => `*${text}*`)
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseInline(src: string, base: Style = {}): Span[] {
  return parseSpans(normalizeHtml(src), base);
}

function parseSpans(src: string, base: Style = {}): Span[] {
  const spans: Span[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) {
      spans.push({ ...base, text: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;

    if (c === "\\" && /[\\`*_{}[\]()#+\-.!~>|]/.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const m = /^(`+)([\s\S]*?)\1(?!`)/.exec(src.slice(i));
      if (m?.[2] !== undefined) {
        flush();
        const inner = m[2].trim() === "" ? m[2] : m[2].replace(/^ (.*) $/, "$1");
        spans.push({ ...base, text: inner, role: "code" });
        i += m[0].length;
        continue;
      }
    }

    if (c === "!" && src[i + 1] === "[") {
      const m = matchLink(src.slice(i + 1));
      if (m) {
        flush();
        spans.push({ ...base, text: `🖼 ${m.text || m.href}`, role: "meta" });
        i += 1 + m.length;
        continue;
      }
    }

    if (c === "[") {
      const m = matchLink(src.slice(i));
      if (m) {
        flush();
        spans.push(...parseSpans(m.text, { ...base, role: "link", underline: true }));
        i += m.length;
        continue;
      }
    }

    if (c === "<") {
      const m = /^<((?:https?|mailto):[^>\s]+)>/.exec(src.slice(i));
      if (m?.[1]) {
        flush();
        spans.push({ ...base, text: m[1], role: "url", underline: true });
        i += m[0].length;
        continue;
      }
    }

    if (c === "~" && src.startsWith("~~", i)) {
      const close = src.indexOf("~~", i + 2);
      if (close > i + 2) {
        flush();
        spans.push(...parseSpans(src.slice(i + 2, close), { ...base, dim: true }));
        i = close + 2;
        continue;
      }
    }

    if ((c === "*" || c === "_") && !(c === "_" && /[\w]/.test(src[i - 1] ?? ""))) {
      const strong = src.startsWith(c + c, i);
      const marker = strong ? c + c : c;
      if (!/\s/.test(src[i + marker.length] ?? " ")) {
        const close = findClose(src, i + marker.length, marker);
        if (close > 0) {
          flush();
          const inner = src.slice(i + marker.length, close);
          spans.push(...parseSpans(inner, strong ? { ...base, bold: true } : { ...base, italic: true }));
          i = close + marker.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  flush();
  return spans.length > 0 ? spans : [{ ...base, text: "" }];
}

// ---------------------------------------------------------------- wrap

/** Greedy word wrap that carries each word's styling with it. */
export function wrapSpans(spans: Span[], width: number, first = 0, hanging = first): Line[] {
  const max = Math.max(1, width);
  const lines: Line[] = [];
  let indent = first;
  let cur: Span[] = [];
  let len = 0;
  let filled = false;

  const begin = (): void => {
    cur = indent > 0 ? [{ text: " ".repeat(indent) }] : [];
    len = indent;
    filled = false;
  };
  const flush = (): void => {
    lines.push({ spans: cur.length > 0 ? cur : [{ text: "" }] });
    indent = hanging;
    begin();
  };
  begin();

  for (const span of spans) {
    const { text, ...style } = span;
    for (const part of text.split(/(\s+)/)) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) {
        if (filled) {
          cur.push({ ...style, text: " " });
          len += 1;
        }
        continue;
      }
      let word = part;
      let w = stringWidth(word);
      if (len + w > max && filled) flush();
      // A word longer than the line (a bare URL) is cut rather than lost.
      while (stringWidth(word) > max - len && max - len > 0) {
        const take = Math.max(1, max - len);
        cur.push({ ...style, text: word.slice(0, take) });
        word = word.slice(take);
        filled = true;
        flush();
        w = stringWidth(word);
      }
      if (word) {
        cur.push({ ...style, text: word });
        len += stringWidth(word);
        filled = true;
      }
    }
  }

  if (filled || lines.length === 0) flush();
  return lines;
}

// --------------------------------------------------------------- blocks

function rule(width: number, char: string, style: Style): Line {
  return { spans: [{ ...style, text: char.repeat(Math.max(1, width)) }] };
}

function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "\\" && trimmed[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  cells.push(buf.trim());
  return cells;
}

function pad(spans: Span[], target: number, align: "left" | "right" | "center"): Span[] {
  const used = spans.reduce((n, s) => n + stringWidth(s.text), 0);
  const gap = Math.max(0, target - used);
  if (gap === 0) return spans;
  if (align === "right") return [{ text: " ".repeat(gap) }, ...spans];
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return [{ text: " ".repeat(left) }, ...spans, { text: " ".repeat(gap - left) }];
  }
  return [...spans, { text: " ".repeat(gap) }];
}

function renderTable(rows: string[][], aligns: ("left" | "right" | "center")[], width: number): Line[] {
  const columns = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((row) => Array.from({ length: columns }, (_, i) => parseInline(row[i] ?? "")));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(1, ...cells.map((row) => (row[i] ?? []).reduce((n, s) => n + stringWidth(s.text), 0))),
  );

  // Shrink the widest columns first until the table fits the pane.
  const gap = 2;
  let total = widths.reduce((a, b) => a + b, 0) + gap * (columns - 1);
  while (total > width) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= 3) break;
    widths[widest] = (widths[widest] as number) - 1;
    total--;
  }

  const out: Line[] = [];
  rows.forEach((_, r) => {
    const spans: Span[] = [];
    (cells[r] as Span[][]).forEach((cell, c) => {
      if (c > 0) spans.push({ text: " ".repeat(gap) });
      const w = widths[c] as number;
      let used = 0;
      const clipped: Span[] = [];
      for (const span of cell) {
        if (used >= w) break;
        const room = w - used;
        const text = stringWidth(span.text) > room ? span.text.slice(0, Math.max(0, room - 1)) + "…" : span.text;
        clipped.push(r === 0 ? { ...span, role: span.role ?? "th", bold: true } : span);
        used += stringWidth(text);
        clipped[clipped.length - 1] = { ...(clipped[clipped.length - 1] as Span), text };
      }
      spans.push(...pad(clipped, w, aligns[c] ?? "left"));
    });
    out.push({ spans });
    if (r === 0) {
      const spansRule: Span[] = [];
      widths.forEach((w, c) => {
        if (c > 0) spansRule.push({ text: " ".repeat(gap) });
        spansRule.push({ text: "─".repeat(w), role: "rule" });
      });
      out.push({ spans: spansRule });
    }
  });
  return out;
}

/**
 * Render markdown to styled lines already wrapped to `width`.
 *
 * `width` is the pane's interior, so a resize re-renders rather than reflows —
 * cheap, and it keeps tables and code gutters honest.
 */
export function renderMarkdown(source: string, width: number): Line[] {
  const w = Math.max(20, Math.floor(width));
  const src = source.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const raw = src.split("\n");
  const out: Line[] = [];
  const blank = (): void => {
    if (out.length > 0 && plain(out[out.length - 1] as Line).trim() !== "") out.push({ spans: [{ text: "" }] });
  };

  let i = 0;

  // YAML front matter, shown rather than hidden: it is usually the metadata a
  // reader opened the file for.
  if (raw[0] === "---") {
    const end = raw.findIndex((l, n) => n > 0 && (l === "---" || l === "..."));
    if (end > 0) {
      for (const line of raw.slice(1, end)) {
        out.push({ spans: [{ text: "▏ ", role: "gutter" }, { text: line, role: "meta", dim: true }] });
      }
      out.push({ spans: [{ text: "" }] });
      i = end + 1;
    }
  }

  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (!text) return;
    const spans = parseInline(text);
    // A paragraph that was only an HTML wrapper leaves nothing to show.
    if (spans.every((span) => span.text.trim() === "")) return;
    out.push(...wrapSpans(spans, w));
  };

  const isBlockStart = (line: string): boolean =>
    line.trim() === "" ||
    HR.test(line) ||
    HEADING.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    LIST.test(line) ||
    TABLE_ROW.test(line);

  for (; i < raw.length; i++) {
    const line = raw[i] as string;

    if (line.trim() === "") {
      flushParagraph();
      blank();
      continue;
    }

    // Setext headings close the paragraph they underline.
    if (paragraph.length > 0 && (SETEXT_H1.test(line) || SETEXT_H2.test(line))) {
      const text = paragraph.join(" ").trim();
      paragraph = [];
      const h1 = SETEXT_H1.test(line);
      blank();
      out.push(...wrapSpans(parseInline(text, { role: h1 ? "h1" : "h2", bold: true }), w));
      out.push(rule(h1 ? w : Math.min(w, stringWidth(text)), h1 ? "━" : "─", { role: h1 ? "h1" : "h2", dim: true }));
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = (fence[1] as string)[0] as string;
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i++;
      for (; i < raw.length; i++) {
        const l = raw[i] as string;
        if (new RegExp(`^ {0,3}${marker === "`" ? "```" : "~~~"}+[ \t]*$`).test(l)) break;
        body.push(l);
      }
      blank();
      const head = lang ? `┌─ ${lang} ` : "┌─ ";
      out.push({
        spans: [
          { text: "┌─ ", role: "gutter" },
          ...(lang ? [{ text: `${lang} `, role: "lang" as Role }] : []),
          { text: "─".repeat(Math.max(0, w - stringWidth(head))), role: "gutter" },
        ],
      });
      for (const l of body) {
        const text = l.replace(/\t/g, "  ");
        out.push({
          spans: [
            { text: "│ ", role: "gutter" },
            { text: stringWidth(text) > w - 2 ? text.slice(0, w - 3) + "…" : text, role: "fence" },
          ],
        });
      }
      out.push({ spans: [{ text: "└" + "─".repeat(Math.max(0, w - 1)), role: "gutter" }] });
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = (heading[1] as string).length;
      const text = heading[2] as string;
      const role: Role = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      blank();
      const prefix: Span[] = level >= 3 ? [{ text: "▸ ", role, dim: true }] : [];
      out.push(...wrapSpans([...prefix, ...parseInline(text, { role, bold: true })], w));
      if (level === 1) out.push(rule(w, "━", { role, dim: true }));
      else if (level === 2) out.push(rule(Math.min(w, stringWidth(text) + 2), "─", { role, dim: true }));
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    if (HR.test(line)) {
      flushParagraph();
      blank();
      out.push(rule(w, "─", { role: "rule" }));
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      for (; i < raw.length; i++) {
        const m = QUOTE.exec(raw[i] as string);
        if (m) body.push(m[1] ?? "");
        else if ((raw[i] as string).trim() !== "" && body.length > 0) body.push(raw[i] as string);
        else break;
      }
      i--;
      blank();
      for (const inner of renderMarkdown(body.join("\n"), w - 2)) {
        out.push({ spans: [{ text: "▌ ", role: "quote" }, ...inner.spans.map((s) => ({ dim: true, ...s }))] });
      }
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    const list = LIST.exec(line);
    if (list) {
      flushParagraph();
      const lead = (list[1] as string).replace(/\t/g, "  ");
      const depth = Math.min(3, Math.floor(lead.length / 2));
      const marker = list[2] as string;
      let rest = list[4] as string;

      // Lazy continuation: fold following plain lines into this item.
      const parts = [rest];
      while (i + 1 < raw.length && !isBlockStart(raw[i + 1] as string)) {
        parts.push((raw[i + 1] as string).trim());
        i++;
      }
      rest = parts.join(" ");

      const task = TASK.exec(rest);
      let checked = false;
      if (task) {
        checked = (task[1] as string).toLowerCase() === "x";
        rest = rest.slice(task[0].length);
      }

      const ordered = /\d/.test(marker);
      const glyph = task ? (checked ? "☑" : "☐") : ordered ? marker : (BULLETS[depth] as string);
      const indent = depth * 2;
      const bullet: Span = { text: `${glyph} `, role: "bullet", bold: ordered };
      const body = parseInline(rest, checked ? { dim: true } : {});
      const lines = wrapSpans([bullet, ...body], w, indent, indent + stringWidth(glyph) + 1);
      out.push(...lines);
      continue;
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(raw[i + 1] ?? "")) {
      flushParagraph();
      const header = splitRow(line);
      const aligns = splitRow(raw[i + 1] as string).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : "left";
      }) as ("left" | "right" | "center")[];
      const rows = [header];
      i += 2;
      for (; i < raw.length && TABLE_ROW.test(raw[i] as string); i++) rows.push(splitRow(raw[i] as string));
      i--;
      blank();
      out.push(...renderTable(rows, aligns, w));
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    // Indented code, but only where a fresh block can start.
    const indented = INDENTED_CODE.exec(line);
    if (indented && paragraph.length === 0) {
      const body: string[] = [];
      for (; i < raw.length; i++) {
        const l = raw[i] as string;
        const m = INDENTED_CODE.exec(l);
        if (m) body.push(m[1] as string);
        else if (l.trim() === "") body.push("");
        else break;
      }
      i--;
      while (body.length > 0 && (body[body.length - 1] as string).trim() === "") body.pop();
      blank();
      for (const l of body) {
        out.push({
          spans: [
            { text: "│ ", role: "gutter" },
            { text: stringWidth(l) > w - 2 ? l.slice(0, w - 3) + "…" : l, role: "fence" },
          ],
        });
      }
      out.push({ spans: [{ text: "" }] });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  while (out.length > 0 && plain(out[out.length - 1] as Line).trim() === "") out.pop();
  return out;
}
