import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, parseInline, toText, type RenderOptions } from "../src/markdown.ts";
import { FLAVORS, isFlavor } from "../src/flavors.ts";
import { emojiFor } from "../src/emoji.ts";

const lines = (src: string, width = 60, options: RenderOptions = {}): string[] =>
  toText(renderMarkdown(src, width, options));

const body = (src: string, width = 60, options: RenderOptions = {}): string =>
  lines(src, width, options).join("\n");

const roles = (src: string, options: RenderOptions = {}): (string | undefined)[] =>
  renderMarkdown(src, 60, options).flatMap((line) => line.spans.map((s) => s.role));

/* ---------------------------------------------------------------- gfm --- */

test("a bare url is linked without angle brackets", () => {
  const spans = parseInline("see https://example.com now");
  const url = spans.find((s) => s.role === "url");
  assert.equal(url?.text, "https://example.com");
});

test("a reference link resolves to its definition", () => {
  const out = body("See [the docs][d].\n\n[d]: https://example.com\n");
  assert.equal(out, "See the docs.", "the definition is consumed, not printed");
});

test("strikethrough is dim and struck", () => {
  const spans = parseInline("~~gone~~");
  assert.equal(spans[0]?.text, "gone");
  assert.equal(spans[0]?.strike, true);
  assert.equal(spans[0]?.dim, true);
});

test("a hard break starts a new line without a blank one", () => {
  assert.deepEqual(lines("one  \ntwo"), ["one", "two"]);
});

test("nested lists indent one level per depth", () => {
  assert.deepEqual(lines("- a\n  - b\n    - c\n      - d"), [
    "• a",
    "  ◦ b",
    "    ▪ c",
    "      · d",
  ]);
});

test("a nested list under a numbered item lines up under its text", () => {
  assert.deepEqual(lines("1. first\n   - under"), ["1. first", "   ◦ under"]);
});

test("a loose list keeps the blank lines between its items", () => {
  assert.deepEqual(lines("- one\n\n- two"), ["• one", "", "• two"]);
});

test("an ordered list starting at a number keeps counting from it", () => {
  assert.deepEqual(lines("5. five\n6. six"), ["5. five", "6. six"]);
});

/* -------------------------------------------------------------- alerts --- */

test("a GitHub alert gets a labelled gutter", () => {
  const out = lines("> [!WARNING]\n> Mind the gap.");
  assert.equal(out[0], "▌ ▲ Warning");
  assert.equal(out[1], "▌ Mind the gap.");
});

test("every alert kind is recognised, case-insensitively", () => {
  for (const [kind, label] of [
    ["NOTE", "Note"],
    ["tip", "Tip"],
    ["Important", "Important"],
    ["WARNING", "Warning"],
    ["caution", "Caution"],
  ]) {
    const out = lines(`> [!${kind}]\n> body`);
    assert.match(out[0] as string, new RegExp(`${label}$`), `${kind} should read as ${label}`);
  }
});

test("an alert is colored by severity, not as a plain quote", () => {
  assert.ok(roles("> [!CAUTION]\n> stop").includes("alert-caution"));
  assert.ok(roles("> ordinary quote").includes("quote"));
});

test("a blockquote that is not an alert stays a blockquote", () => {
  assert.deepEqual(lines("> [!NOPE]\n> body"), ["▌ [!NOPE] body"]);
});

/* ----------------------------------------------------------- footnotes --- */

test("a footnote is numbered inline and printed at the foot", () => {
  const out = lines("Claim[^a].\n\n[^a]: The evidence.\n");
  assert.equal(out[0], "Claim[1].");
  assert.equal(out.at(-1), "1. The evidence.");
});

test("footnotes are numbered by first reference, not by definition order", () => {
  const out = body("See [^b] then [^a].\n\n[^a]: Ay.\n\n[^b]: Bee.\n");
  assert.match(out, /See \[1\] then \[2\]\./);
  assert.match(out, /1\. Bee\./);
  assert.match(out, /2\. Ay\./);
});

test("the same footnote cited twice keeps one number", () => {
  const out = lines("One[^x] and two[^x].\n\n[^x]: Once.\n");
  assert.equal(out[0], "One[1] and two[1].");
});

test("a footnote defined and never cited is still shown", () => {
  const out = body("Nothing here.\n\n[^loose]: Orphan.\n");
  assert.match(out, /• Orphan\./);
});

test("a document with no footnotes gets no footnote rule", () => {
  assert.deepEqual(lines("Just text."), ["Just text."]);
});

/* -------------------------------------------------------------- reddit --- */

const reddit: RenderOptions = { flavor: "reddit" };

test("a spoiler is blocked out, and revealed on request", () => {
  assert.equal(body(">!hidden!<", 60, reddit), "██████");
  assert.equal(body(">!hidden!<", 60, { ...reddit, spoilers: true }), "hidden");
});

test("a spoiler stays hidden with no color at all", () => {
  // Blocks, not a color trick, so `--color never` and a pipe still hide it.
  assert.ok(!body("secret is >!42!<", 60, reddit).includes("42"));
});

test("superscript uses real glyphs when every character has one", () => {
  assert.equal(body("mc^2", 60, reddit), "mc²");
  assert.equal(body("x^(n+1)", 60, reddit), "xⁿ⁺¹");
});

test("superscript keeps its caret when a character cannot be raised", () => {
  // There is no superscript q in Unicode.
  assert.equal(body("^(quick)", 60, reddit), "^quick");
});

test("subreddit and user links are linked", () => {
  assert.equal(body("via r/webdev and u/someone", 60, reddit), "via r/webdev and u/someone");
  assert.ok(roles("r/webdev", reddit).includes("link"));
});

test("a slash-prefixed subreddit link works too", () => {
  assert.ok(roles("see /r/webdev", reddit).includes("link"));
});

test("a subreddit link inside a word is left alone", () => {
  assert.ok(!roles("path/r/thing", reddit).includes("link"));
});

/* ------------------------------------------------------- flavor bounds --- */

test("reddit syntax does nothing under the github flavor", () => {
  assert.equal(body("text >!hidden!< and mc^2", 60, { flavor: "github" }), "text >!hidden!< and mc^2");
});

test("a spoiler opening a line is not swallowed by blockquote syntax", () => {
  // ">" starts a quote everywhere else, so the reddit flavor has to claim it.
  assert.equal(body(">!hidden!< tail", 60, reddit), "██████ tail");
  assert.equal(lines("> quoted", 60, reddit)[0], "▌ quoted", "a real quote still quotes");
});

test("github extras do nothing under commonmark", () => {
  const out = body("Hi :rocket: note[^1]\n\n[^1]: body\n", 60, { flavor: "commonmark" });
  assert.match(out, /:rocket:/, "the shortcode is left as written");
});

test("the all flavor takes both dialects at once", () => {
  const out = body("Ship it :rocket: >!now!< mc^2", 60, { flavor: "all" });
  assert.match(out, /🚀/);
  assert.match(out, /█/);
  assert.match(out, /mc²/);
});

test("emoji shortcodes resolve, and unknown ones are left alone", () => {
  assert.equal(body("ship :rocket:"), "ship 🚀");
  assert.equal(body("no :notarealemoji: here"), "no :notarealemoji: here");
  assert.equal(emojiFor("notarealemoji"), null);
});

test("a colon that is not a shortcode survives", () => {
  assert.equal(body("time 10:30 and a ratio 3:1"), "time 10:30 and a ratio 3:1");
});

test("every flavor name is recognised, and nothing else is", () => {
  for (const flavor of FLAVORS) assert.ok(isFlavor(flavor));
  assert.equal(isFlavor("markdown"), false);
});

test("every flavor renders ordinary markdown the same way", () => {
  const src = "# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n";
  const expected = lines(src, 60, { flavor: "commonmark" });
  for (const flavor of FLAVORS) {
    assert.deepEqual(lines(src, 60, { flavor }), expected, `${flavor} should not change plain markdown`);
  }
});

/* ---------------------------------------------------------------- code --- */

test("a fenced block is not searched for any flavor's syntax", () => {
  const out = lines("```\n>!spoiler!< :rocket: mc^2\n```", 60, { flavor: "all" });
  assert.equal(out[1], "│ >!spoiler!< :rocket: mc^2");
});

test("html inside a fence is left as written", () => {
  const out = lines("```html\n<b>bold</b>\n```");
  assert.equal(out[1], "│ <b>bold</b>");
});

test("html inside an indented block is left as written", () => {
  const out = lines("text\n\n    <b>bold</b>\n");
  assert.equal(out.at(-1), "│ <b>bold</b>");
});
