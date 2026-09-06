/**
 * Markdown flavors, as marked extensions.
 *
 * marked handles CommonMark and GFM — tables, task lists, strikethrough and
 * bare-URL autolinks — so what lives here is only what GitHub and Reddit added
 * on top and marked does not ship: footnotes, alerts, spoilers, superscript,
 * subreddit and user links, and `:shortcode:` emoji.
 *
 * Every extension is a tokenizer only. readm3 never renders HTML: it walks the
 * token tree itself in `markdown.ts` and emits styled spans, so a `renderer` on
 * these would be dead weight.
 */
import { Lexer, Marked, type MarkedExtension, type Token, type TokenizerAndRendererExtension } from "marked";
import { emojiFor } from "./emoji.ts";

export type Flavor = "commonmark" | "github" | "reddit" | "all";

/* ----------------------------------------------------------- token types --- */

/** A `[^1]: …` definition, with its body already lexed as blocks. */
export interface FootnoteDefToken {
  type: "footnoteDef";
  raw: string;
  label: string;
  tokens: Token[];
}

/** A `[^1]` citation in running text. */
export interface FootnoteRefToken {
  type: "footnoteRef";
  raw: string;
  label: string;
}

/** Reddit's `>!hidden!<`. */
export interface SpoilerToken {
  type: "spoiler";
  raw: string;
  text: string;
  tokens: Token[];
}

/** Reddit's `^(raised)`. */
export interface SuperscriptToken {
  type: "superscript";
  raw: string;
  text: string;
  tokens: Token[];
}

/** Reddit's `r/sub` and `u/user`. */
export interface RedditLinkToken {
  type: "redditLink";
  raw: string;
  kind: string;
  name: string;
  href: string;
}

/** A resolved `:shortcode:`. */
export interface EmojiToken {
  type: "emoji";
  raw: string;
  text: string;
}

export const FLAVORS: Flavor[] = ["commonmark", "github", "reddit", "all"];

export const DEFAULT_FLAVOR: Flavor = "github";

export function isFlavor(value: string): value is Flavor {
  return (FLAVORS as string[]).includes(value);
}

/* ------------------------------------------------------------- footnotes --- */

/** `[^1]: the note`, with indented continuation lines folded in. */
const footnoteDef: TokenizerAndRendererExtension = {
  name: "footnoteDef",
  level: "block",
  start(src: string) {
    const m = /^\[\^[^\]\n]+\]:/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string) {
    const m = /^\[\^([^\]\n]+)\]:[ \t]*([^\n]*(?:\n(?:[ \t]+[^\n]*|[ \t]*(?=\n)))*)/.exec(src);
    if (!m) return undefined;
    const body = (m[2] ?? "")
      .split("\n")
      .map((line) => line.replace(/^(?: {1,4}|\t)/, ""))
      .join("\n")
      .trim();
    return {
      type: "footnoteDef",
      raw: m[0],
      label: m[1] as string,
      tokens: this.lexer.blockTokens(body ? `${body}\n` : "\n") as Token[],
    };
  },
};

/** `[^1]` in running text. Must out-run the link tokenizer, so it is an extension. */
const footnoteRef: TokenizerAndRendererExtension = {
  name: "footnoteRef",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("[^");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^\[\^([^\]\n]+)\]/.exec(src);
    if (!m) return undefined;
    return { type: "footnoteRef", raw: m[0], label: m[1] as string };
  },
};

/* -------------------------------------------------------------- reddit --- */

/** `>!spoiler!<`. */
const spoiler: TokenizerAndRendererExtension = {
  name: "spoiler",
  level: "inline",
  start(src: string) {
    const i = src.indexOf(">!");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^>!([\s\S]+?)!</.exec(src);
    if (!m) return undefined;
    return {
      type: "spoiler",
      raw: m[0],
      text: m[1] as string,
      tokens: this.lexer.inlineTokens(m[1] as string) as Token[],
    };
  },
};

/**
 * A paragraph opening with `>!`, claimed before the blockquote tokenizer sees it.
 *
 * `>` starts a blockquote in every other dialect, so without this a spoiler at
 * the start of a line is quoted and its `>!` is eaten. Reddit reads the spoiler,
 * and so do we — but only under a flavor that asked for it.
 */
const spoilerParagraph: TokenizerAndRendererExtension = {
  name: "spoilerParagraph",
  level: "block",
  start(src: string) {
    const m = /^>!/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string) {
    if (!src.startsWith(">!")) return undefined;
    const m = /^[^\n]+(?:\n(?!\s*\n)[^\n]+)*/.exec(src);
    if (!m) return undefined;
    const text = m[0] as string;
    return {
      type: "paragraph",
      raw: text,
      text,
      tokens: this.lexer.inlineTokens(text) as Token[],
    };
  },
};

/** `^(a phrase)` or `^word`. */
const superscript: TokenizerAndRendererExtension = {
  name: "superscript",
  level: "inline",
  start(src: string) {
    const i = src.indexOf("^");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^\^\(([^)\n]+)\)|^\^([^\s^()]+)/.exec(src);
    if (!m) return undefined;
    const text = (m[1] ?? m[2] ?? "").trim();
    if (!text) return undefined;
    return { type: "superscript", raw: m[0], text, tokens: this.lexer.inlineTokens(text) as Token[] };
  },
};

/**
 * `r/subreddit` and `u/user`, with or without a leading slash.
 *
 * `start` carries the word-boundary check because a tokenizer only ever sees
 * the source from a position marked, and `foo/r/bar` must not qualify.
 */
const redditLink: TokenizerAndRendererExtension = {
  name: "redditLink",
  level: "inline",
  start(src: string) {
    const m = /(^|[^\w/])(\/?[ru]\/[A-Za-z0-9][A-Za-z0-9_-]{1,})/.exec(src);
    return m ? m.index + (m[1] as string).length : undefined;
  },
  tokenizer(src: string) {
    const m = /^\/?([ru])\/([A-Za-z0-9][A-Za-z0-9_-]{1,})/.exec(src);
    if (!m) return undefined;
    return {
      type: "redditLink",
      raw: m[0],
      kind: m[1] as string,
      name: m[2] as string,
      href: `https://www.reddit.com/${m[1]}/${m[2]}/`,
    };
  },
};

/* --------------------------------------------------------------- emoji --- */

/** `:tada:`, left as written when the name is not one we know. */
const emoji: TokenizerAndRendererExtension = {
  name: "emoji",
  level: "inline",
  start(src: string) {
    const i = src.indexOf(":");
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^:([a-z0-9_+-]+):/.exec(src);
    if (!m) return undefined;
    const glyph = emojiFor(m[1] as string);
    if (glyph === null) return undefined;
    return { type: "emoji", raw: m[0], text: glyph };
  },
};

/* -------------------------------------------------------------- lexers --- */

const GITHUB = [footnoteDef, footnoteRef, emoji];
const REDDIT = [spoilerParagraph, spoiler, superscript, redditLink];

function extensionsFor(flavor: Flavor): TokenizerAndRendererExtension[] {
  switch (flavor) {
    case "commonmark":
      return [];
    case "github":
      return GITHUB;
    case "reddit":
      return REDDIT;
    case "all":
      return [...GITHUB, ...REDDIT];
  }
}

const cache = new Map<Flavor, Marked>();

/**
 * The configured marked instance for a flavor. Cached: building one walks every
 * extension, and a resize re-renders the open document as its width changes.
 */
export function lexerFor(flavor: Flavor = DEFAULT_FLAVOR): Marked {
  const hit = cache.get(flavor);
  if (hit) return hit;
  const extensions = extensionsFor(flavor);
  const marked = new Marked({ gfm: flavor !== "commonmark", breaks: false });
  if (extensions.length > 0) marked.use({ extensions } as MarkedExtension);
  cache.set(flavor, marked);
  return marked;
}

/**
 * A fresh Lexer carrying the flavor's options.
 *
 * `Marked#lexer` is a bound helper, not the lexer itself, and the extension
 * tokenizers need `this.lexer` to recurse — so the Lexer is built here from the
 * instance defaults rather than reached for through the facade.
 */
function lexer(flavor: Flavor): Lexer {
  return new Lexer(lexerFor(flavor).defaults);
}

/** Block tokens for a source string, under a flavor. */
export function lex(source: string, flavor: Flavor = DEFAULT_FLAVOR): Token[] {
  return lexer(flavor).lex(source) as Token[];
}

/** Inline tokens for a fragment, under a flavor. */
export function lexInline(source: string, flavor: Flavor = DEFAULT_FLAVOR): Token[] {
  return lexer(flavor).inlineTokens(source) as Token[];
}
