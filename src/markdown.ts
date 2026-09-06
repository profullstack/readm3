/**
 * Markdown to styled lines, instead of to a DOM.
 *
 * Parsing is marked's — CommonMark, GFM, and the extensions in `flavors.ts`
 * for what GitHub and Reddit added on top. What lives here is the half marked
 * has no opinion about: turning a token tree into fixed-width lines of spans
 * that a terminal can paint.
 *
 * Spans carry a semantic `role` rather than a color; the viewer maps roles onto
 * the active HQTUI theme. That split keeps this file pure and testable without
 * a terminal, and lets a theme change re-color a document without re-parsing it.
 */
import { stringWidth } from "@profullstack/hqtui";
import type { Token, Tokens } from "marked";
import {
  DEFAULT_FLAVOR,
  lex,
  lexInline,
  type EmojiToken,
  type Flavor,
  type FootnoteDefToken,
  type FootnoteRefToken,
  type RedditLinkToken,
  type SpoilerToken,
  type SuperscriptToken,
} from "./flavors.ts";

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
  | "th"
  | "spoiler"
  | "sup"
  | "footnote"
  | "alert-note"
  | "alert-tip"
  | "alert-important"
  | "alert-warning"
  | "alert-caution";

export interface Span {
  text: string;
  role?: Role;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strike?: boolean;
}

export interface Line {
  spans: Span[];
}

type Style = Omit<Span, "text">;

export interface RenderOptions {
  /** Which dialect's extras to honor. Defaults to GitHub. */
  flavor?: Flavor | undefined;
  /** Show spoiler text rather than blocking it out. */
  spoilers?: boolean | undefined;
}

interface Ctx {
  flavor: Flavor;
  spoilers: boolean;
  /** Footnote label to its number, in order of first reference. */
  numbers: Map<string, number>;
  /** Footnote label to the block tokens of its definition. */
  defs: Map<string, Token[]>;
}

const BULLETS = ["•", "◦", "▪", "·"];

/**
 * A hard break inside a paragraph, carried as a sentinel because wrapping
 * works on one logical line at a time.
 */
const BREAK = "\u0000";

const ALERTS: Record<string, { role: Role; label: string; glyph: string }> = {
  note: { role: "alert-note", label: "Note", glyph: "ℹ" },
  tip: { role: "alert-tip", label: "Tip", glyph: "✓" },
  important: { role: "alert-important", label: "Important", glyph: "◆" },
  warning: { role: "alert-warning", label: "Warning", glyph: "▲" },
  caution: { role: "alert-caution", label: "Caution", glyph: "✕" },
};

const ALERT_HEAD = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

function sameStyle(a: Span, b: Span): boolean {
  return (
    a.role === b.role &&
    !a.bold === !b.bold &&
    !a.italic === !b.italic &&
    !a.underline === !b.underline &&
    !a.dim === !b.dim &&
    !a.strike === !b.strike
  );
}

/**
 * Glue neighbouring spans that share a style back together.
 *
 * Wrapping splits a line into one span per word, which no consumer wants: it is
 * an escape sequence per word when printed, and a layout child per word on
 * screen.
 */
export function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, span)) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

/** The visible text of a line, with all styling dropped. Handy in tests. */
export function plain(line: Line): string {
  return line.spans.map((s) => s.text).join("");
}

/** Every line as plain text. */
export function toText(lines: Line[]): string[] {
  return lines.map(plain);
}

/* ------------------------------------------------------------------ html --- */

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

/* ---------------------------------------------------------------- inline --- */

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ",
  g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ",
  m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ",
  t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ",
  z: "ᶻ",
};

/**
 * Raise text into real superscript glyphs when every character has one.
 *
 * Unicode has no superscript `q`, and only some capitals, so a partial mapping
 * would read as a ransom note. Anything that does not map keeps its caret.
 */
function raise(text: string): string | null {
  let out = "";
  for (const ch of text) {
    const up = SUPERSCRIPTS[ch.toLowerCase()];
    if (up === undefined) return null;
    out += up;
  }
  return out;
}

function inlineSpans(tokens: Token[], base: Style, ctx: Ctx): Span[] {
  // A block whose inline run holds raw HTML is re-lexed with the HTML folded
  // into markdown. Doing it here rather than over the whole source means fenced
  // and indented code are never touched: they are not inline runs.
  if (tokens.some((t) => t.type === "html")) {
    const raw = tokens.map((t) => t.raw).join("");
    const cleaned = normalizeHtml(raw);
    if (cleaned !== raw) tokens = lexInline(cleaned, ctx.flavor);
  }

  const spans: Span[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
      case "escape": {
        const t = token as Tokens.Text;
        // A `text` token carries its own inline children when it came out of a
        // list item; anything else is a leaf.
        if (t.tokens && t.tokens.length > 0) spans.push(...inlineSpans(t.tokens, base, ctx));
        else spans.push({ ...base, text: decode(t.text) });
        break;
      }
      case "strong":
        spans.push(...inlineSpans((token as Tokens.Strong).tokens, { ...base, bold: true }, ctx));
        break;
      case "em":
        spans.push(...inlineSpans((token as Tokens.Em).tokens, { ...base, italic: true }, ctx));
        break;
      case "del":
        spans.push(...inlineSpans((token as Tokens.Del).tokens, { ...base, dim: true, strike: true }, ctx));
        break;
      case "codespan":
        spans.push({ ...base, text: decode((token as Tokens.Codespan).text), role: "code" });
        break;
      case "br":
        spans.push({ text: BREAK });
        break;
      case "link": {
        const link = token as Tokens.Link;
        // A bare URL marked autolinked reads as a URL, not as link text.
        const role: Role = link.text === link.href ? "url" : "link";
        spans.push(...inlineSpans(link.tokens, { ...base, role, underline: true }, ctx));
        break;
      }
      case "image": {
        const img = token as Tokens.Image;
        spans.push({ ...base, text: `\u{1f5bc} ${img.text || img.href}`, role: "meta" });
        break;
      }
      case "html":
        // Survives only when normalizing changed nothing, i.e. a bare tag.
        break;
      case "emoji":
        spans.push({ ...base, text: (token as unknown as EmojiToken).text });
        break;
      case "spoiler": {
        const inner = token as unknown as SpoilerToken;
        if (ctx.spoilers) {
          spans.push(...inlineSpans(inner.tokens, { ...base, role: "spoiler" }, ctx));
        } else {
          // Blocked out rather than colored out, so it stays hidden with
          // --color never and in a pipe.
          spans.push({ ...base, text: "█".repeat(Math.max(1, stringWidth(inner.text))), role: "spoiler" });
        }
        break;
      }
      case "superscript": {
        const sup = token as unknown as SuperscriptToken;
        const raised = raise(sup.text);
        if (raised) spans.push({ ...base, text: raised, role: "sup" });
        else spans.push({ ...base, text: `^${sup.text}`, role: "sup", dim: true });
        break;
      }
      case "redditLink": {
        const rl = token as unknown as RedditLinkToken;
        spans.push({ ...base, text: `${rl.kind}/${rl.name}`, role: "link", underline: true });
        break;
      }
      case "footnoteRef": {
        const ref = token as unknown as FootnoteRefToken;
        spans.push({ ...base, text: `[${numberFor(ref.label, ctx)}]`, role: "footnote" });
        break;
      }
      default: {
        const any = token as { text?: string; raw?: string };
        if (any.text) spans.push({ ...base, text: decode(any.text) });
        break;
      }
    }
  }
  return spans.length > 0 ? spans : [{ ...base, text: "" }];
}

/** marked escapes for HTML output; a terminal wants the characters back. */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function numberFor(label: string, ctx: Ctx): number {
  const seen = ctx.numbers.get(label);
  if (seen !== undefined) return seen;
  const next = ctx.numbers.size + 1;
  ctx.numbers.set(label, next);
  return next;
}

/** Inline markdown to spans. Exported because the site and tests both want it. */
export function parseInline(src: string, base: Style = {}, options: RenderOptions = {}): Span[] {
  const ctx = context(options);
  return mergeSpans(inlineSpans(lexInline(normalizeHtml(src), ctx.flavor), base, ctx));
}

/* ------------------------------------------------------------------ wrap --- */

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
    // A wrapped line should not carry the space that ended it.
    while (cur.length > 0 && (cur[cur.length - 1] as Span).text.trim() === "") cur.pop();
    const last = cur[cur.length - 1];
    if (last) last.text = last.text.replace(/[ \t]+$/, "");
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

/** Wrap a run that may hold hard breaks, which start a line without a blank. */
function wrapBlock(spans: Span[], width: number, first = 0, hanging = first): Line[] {
  if (!spans.some((s) => s.text.includes(BREAK))) return wrapSpans(spans, width, first, hanging);

  const segments: Span[][] = [[]];
  for (const span of spans) {
    if (!span.text.includes(BREAK)) {
      (segments[segments.length - 1] as Span[]).push(span);
      continue;
    }
    span.text.split(BREAK).forEach((part, index) => {
      if (index > 0) segments.push([]);
      if (part) (segments[segments.length - 1] as Span[]).push({ ...span, text: part });
    });
  }

  const out: Line[] = [];
  segments.forEach((segment, index) => {
    out.push(...wrapSpans(segment, width, index === 0 ? first : hanging, hanging));
  });
  return out;
}

/* ---------------------------------------------------------------- blocks --- */

function rule(width: number, char: string, style: Style): Line {
  return { spans: [{ ...style, text: char.repeat(Math.max(1, width)) }] };
}

function blankLine(): Line {
  return { spans: [{ text: "" }] };
}

/** Drop the blank lines a nested render leaves at either end. */
function trim(lines: Line[]): Line[] {
  let start = 0;
  let end = lines.length;
  while (start < end && plain(lines[start] as Line).trim() === "") start++;
  while (end > start && plain(lines[end - 1] as Line).trim() === "") end--;
  return lines.slice(start, end);
}

function prefixed(lines: Line[], first: Span[], rest: Span[]): Line[] {
  return lines.map((line, index) => ({
    spans: [...(index === 0 ? first : rest).map((s) => ({ ...s })), ...line.spans],
  }));
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

function renderTable(token: Tokens.Table, width: number, ctx: Ctx): Line[] {
  const header = token.header.map((cell) => inlineSpans(cell.tokens, { role: "th", bold: true }, ctx));
  const body = token.rows.map((row) => row.map((cell) => inlineSpans(cell.tokens, {}, ctx)));
  const rows = [header, ...body];
  const columns = Math.max(...rows.map((r) => r.length));
  const aligns = token.align.map((a) => a ?? "left") as ("left" | "right" | "center")[];

  const cells = rows.map((row) => Array.from({ length: columns }, (_, i) => row[i] ?? [{ text: "" }]));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(1, ...cells.map((row) => (row[i] as Span[]).reduce((n, s) => n + stringWidth(s.text), 0))),
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
  cells.forEach((row, r) => {
    const spans: Span[] = [];
    row.forEach((cell, c) => {
      if (c > 0) spans.push({ text: " ".repeat(gap) });
      const w = widths[c] as number;
      let used = 0;
      const clipped: Span[] = [];
      for (const span of cell) {
        if (used >= w) break;
        const room = w - used;
        const text =
          stringWidth(span.text) > room ? `${span.text.slice(0, Math.max(0, room - 1))}…` : span.text;
        clipped.push({ ...span, text });
        used += stringWidth(text);
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

function renderCode(text: string, lang: string, width: number, framed = true): Line[] {
  const out: Line[] = [];
  const head = lang ? `┌─ ${lang} ` : "┌─ ";
  if (framed) out.push({
    spans: [
      { text: "┌─ ", role: "gutter" },
      ...(lang ? [{ text: `${lang} `, role: "lang" as Role }] : []),
      { text: "─".repeat(Math.max(0, width - stringWidth(head))), role: "gutter" },
    ],
  });
  for (const raw of text.replace(/\n$/, "").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    out.push({
      spans: [
        { text: "│ ", role: "gutter" },
        { text: stringWidth(line) > width - 2 ? `${line.slice(0, width - 3)}…` : line, role: "fence" },
      ],
    });
  }
  if (framed) out.push({ spans: [{ text: `└${"─".repeat(Math.max(0, width - 1))}`, role: "gutter" }] });
  return out;
}

function renderQuote(token: Tokens.Blockquote, width: number, ctx: Ctx): Line[] {
  const inner = Math.max(4, width - 2);
  const alert = ALERT_HEAD.exec(token.text);

  if (alert) {
    const kind = ALERTS[(alert[1] as string).toLowerCase()] as (typeof ALERTS)[string];
    const body = token.text.slice(alert[0].length);
    const lines = trim(renderTokens(lex(body, ctx.flavor), inner, ctx, 0));
    const head: Line = {
      spans: [{ text: `${kind.glyph} ${kind.label}`, role: kind.role, bold: true }],
    };
    return prefixed([head, ...lines], [{ text: "▌ ", role: kind.role }], [
      { text: "▌ ", role: kind.role },
    ]);
  }

  const lines = trim(renderTokens(token.tokens, inner, ctx, 0));
  return prefixed(
    lines.map((line) => ({ spans: line.spans.map((s) => ({ dim: true, ...s })) })),
    [{ text: "▌ ", role: "quote" }],
    [{ text: "▌ ", role: "quote" }],
  );
}

function renderList(token: Tokens.List, width: number, ctx: Ctx, depth: number): Line[] {
  const out: Line[] = [];
  const start = typeof token.start === "number" && Number.isFinite(token.start) ? token.start : 1;

  token.items.forEach((item, index) => {
    const glyph = item.task
      ? item.checked
        ? "☑"
        : "☐"
      : token.ordered
        ? `${start + index}.`
        : (BULLETS[depth % BULLETS.length] as string);
    const lead = stringWidth(glyph) + 1;
    const inner = Math.max(8, width - lead);

    // The checkbox is a marker, not content: it is already in the glyph.
    const children = item.tokens.filter((t) => t.type !== "checkbox");
    const style: Style = item.task && item.checked ? { dim: true } : {};
    const lines = trim(renderTokens(children, inner, ctx, depth + 1, style, !token.loose));

    out.push(
      ...prefixed(
        lines.length > 0 ? lines : [blankLine()],
        [{ text: `${glyph} `, role: "bullet", bold: token.ordered }],
        [{ text: " ".repeat(lead) }],
      ),
    );
    if (token.loose && index < token.items.length - 1) out.push(blankLine());
  });

  return out;
}

function renderHeading(token: Tokens.Heading, width: number, ctx: Ctx): Line[] {
  const role: Role = token.depth === 1 ? "h1" : token.depth === 2 ? "h2" : "h3";
  const prefix: Span[] = token.depth >= 3 ? [{ text: "▸ ", role, dim: true }] : [];
  const spans = [...prefix, ...inlineSpans(token.tokens, { role, bold: true }, ctx)];
  const out = wrapBlock(spans, width);
  const text = out.map(plain).join(" ");
  if (token.depth === 1) out.push(rule(width, "━", { role, dim: true }));
  else if (token.depth === 2) out.push(rule(Math.min(width, stringWidth(text) + 2), "─", { role, dim: true }));
  return out;
}

/**
 * A run of block tokens to lines, with one blank line between blocks.
 *
 * `depth` only selects the bullet glyph; indentation comes from the caller
 * prefixing what it gets back, so a nested list, a code block and a table
 * inside a list item all line up the same way.
 */
function renderTokens(
  tokens: Token[],
  width: number,
  ctx: Ctx,
  depth: number,
  base: Style = {},
  tight = false,
): Line[] {
  const out: Line[] = [];
  const w = Math.max(4, width);

  const push = (lines: Line[]): void => {
    if (lines.length === 0) return;
    if (out.length > 0 && !tight) out.push(blankLine());
    out.push(...lines);
  };

  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "def":
      case "footnoteDef":
        break;
      case "heading":
        push(renderHeading(token as Tokens.Heading, w, ctx));
        break;
      case "paragraph": {
        const spans = inlineSpans((token as Tokens.Paragraph).tokens, base, ctx);
        if (spans.every((s) => s.text.trim() === "")) break;
        push(wrapBlock(spans, w));
        break;
      }
      case "text": {
        const t = token as Tokens.Text;
        const spans = t.tokens ? inlineSpans(t.tokens, base, ctx) : [{ ...base, text: decode(t.text) }];
        if (spans.every((s) => s.text.trim() === "")) break;
        push(wrapBlock(spans, w));
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        // Indented code has no info string and no fence to echo, so it keeps a
        // bare gutter; only a real fence is framed.
        push(renderCode(code.text, code.lang ?? "", w, code.codeBlockStyle !== "indented"));
        break;
      }
      case "blockquote":
        push(renderQuote(token as Tokens.Blockquote, w, ctx));
        break;
      case "list":
        push(renderList(token as Tokens.List, w, ctx, depth));
        break;
      case "table":
        push(renderTable(token as Tokens.Table, w, ctx));
        break;
      case "hr":
        push([rule(w, "─", { role: "rule" })]);
        break;
      case "html": {
        // A block of raw HTML: fold it to markdown and render what is left.
        const cleaned = normalizeHtml((token as Tokens.HTML).raw).trim();
        if (!cleaned) break;
        push(trim(renderTokens(lex(cleaned, ctx.flavor), w, ctx, depth, base)));
        break;
      }
      default: {
        const any = token as { text?: string };
        if (any.text?.trim()) push(wrapBlock([{ ...base, text: decode(any.text) }], w));
        break;
      }
    }
  }

  return out;
}

/** The numbered notes, rendered under a rule at the foot of the document. */
function renderFootnotes(width: number, ctx: Ctx): Line[] {
  if (ctx.defs.size === 0) return [];

  // Referenced notes first, in the order they were cited; then any that were
  // defined and never used, which is worth seeing rather than dropping.
  const referenced = [...ctx.numbers.entries()]
    .sort((a, b) => a[1] - b[1])
    .filter(([label]) => ctx.defs.has(label));
  const orphans = [...ctx.defs.keys()].filter((label) => !ctx.numbers.has(label));

  const entries: [string, string][] = [
    ...referenced.map(([label, n]) => [label, `${n}.`] as [string, string]),
    ...orphans.map((label) => [label, "•"] as [string, string]),
  ];
  if (entries.length === 0) return [];

  const out: Line[] = [blankLine(), rule(width, "─", { role: "rule" }), blankLine()];
  entries.forEach(([label, marker], index) => {
    if (index > 0) out.push(blankLine());
    const lead = stringWidth(marker) + 1;
    const lines = trim(renderTokens(ctx.defs.get(label) as Token[], Math.max(8, width - lead), ctx, 0));
    out.push(
      ...prefixed(lines.length > 0 ? lines : [blankLine()], [{ text: `${marker} `, role: "footnote" }], [
        { text: " ".repeat(lead) },
      ]),
    );
  });
  return out;
}

function collectDefs(tokens: Token[], ctx: Ctx): void {
  for (const token of tokens) {
    if (token.type === "footnoteDef") {
      const def = token as unknown as FootnoteDefToken;
      if (!ctx.defs.has(def.label)) ctx.defs.set(def.label, def.tokens);
    }
  }
}

function context(options: RenderOptions): Ctx {
  return {
    flavor: options.flavor ?? DEFAULT_FLAVOR,
    spoilers: options.spoilers ?? false,
    numbers: new Map(),
    defs: new Map(),
  };
}

/**
 * Render markdown to styled lines already wrapped to `width`.
 *
 * `width` is the pane's interior, so a resize re-renders rather than reflows —
 * cheap, and it keeps tables and code gutters honest.
 */
export function renderMarkdown(source: string, width: number, options: RenderOptions = {}): Line[] {
  const w = Math.max(20, Math.floor(width));
  const ctx = context(options);
  const src = source.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");

  const out: Line[] = [];
  let body = src;

  // YAML front matter, shown rather than hidden: it is usually the metadata a
  // reader opened the file for.
  const lines = src.split("\n");
  if (lines[0] === "---") {
    const end = lines.findIndex((l, n) => n > 0 && (l === "---" || l === "..."));
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        out.push({ spans: [{ text: "▏ ", role: "gutter" }, { text: line, role: "meta", dim: true }] });
      }
      out.push(blankLine());
      body = lines.slice(end + 1).join("\n");
    }
  }

  const tokens = lex(body, ctx.flavor);
  collectDefs(tokens, ctx);
  const rendered = renderTokens(tokens, w, ctx, 0);
  if (out.length > 0 && rendered.length > 0) out.push(blankLine());
  out.push(...rendered);
  out.push(...renderFootnotes(w, ctx));

  while (out.length > 0 && plain(out[out.length - 1] as Line).trim() === "") out.pop();
  return out.map((line) => ({ spans: mergeSpans(line.spans) }));
}
