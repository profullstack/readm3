import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, plain, renderMarkdown, toText, wrapSpans } from "../src/markdown.ts";

const lines = (source: string, width = 60): string[] => toText(renderMarkdown(source, width));

test("a heading is emphasised and underlined", () => {
  const out = renderMarkdown("# Title", 20);
  assert.equal(plain(out[0]!), "Title");
  assert.equal(out[0]!.spans[0]!.role, "h1");
  assert.equal(out[0]!.spans[0]!.bold, true);
  assert.match(plain(out[1]!), /^━+$/);
});

test("heading levels map onto three roles", () => {
  assert.equal(renderMarkdown("## Two", 20)[0]!.spans[0]!.role, "h2");
  assert.equal(renderMarkdown("### Three", 20)[0]!.spans.at(-1)!.role, "h3");
  assert.equal(renderMarkdown("###### Six", 20)[0]!.spans.at(-1)!.role, "h3");
});

test("setext headings close the paragraph above them", () => {
  const out = renderMarkdown("Title\n=====\n", 20);
  assert.equal(plain(out[0]!), "Title");
  assert.equal(out[0]!.spans[0]!.role, "h1");
});

test("inline emphasis and code become styled spans", () => {
  const spans = parseInline("plain **bold** and `code` and *em*");
  assert.equal(spans.find((s) => s.text === "bold")?.bold, true);
  assert.equal(spans.find((s) => s.text === "code")?.role, "code");
  assert.equal(spans.find((s) => s.text === "em")?.italic, true);
});

test("underscores inside a word are left alone", () => {
  const spans = parseInline("call snake_case_name here");
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.text, "call snake_case_name here");
});

test("a link keeps its text, underlined, and drops the url", () => {
  const spans = parseInline("see [the docs](https://example.com/x) now");
  const link = spans.find((s) => s.text === "the docs");
  assert.equal(link?.role, "link");
  assert.equal(link?.underline, true);
  assert.equal(spans.map((s) => s.text).join(""), "see the docs now");
});

test("an image renders as a labelled placeholder", () => {
  const spans = parseInline("![a cat](cat.png)");
  assert.equal(spans[0]!.role, "meta");
  assert.match(spans[0]!.text, /a cat/);
});

test("an escaped marker stays literal", () => {
  assert.equal(parseInline("2 \\* 3 \\* 4").map((s) => s.text).join(""), "2 * 3 * 4");
});

test("a fenced block is framed and its language labelled", () => {
  const out = lines("```ts\nconst x = 1;\n```", 30);
  assert.match(out[0]!, /^┌─ ts ─+$/);
  assert.equal(out[1]!, "│ const x = 1;");
  assert.match(out[2]!, /^└─+$/);
});

test("markdown inside a fence is not interpreted", () => {
  const out = renderMarkdown("```\n# not a heading\n```", 30);
  assert.equal(plain(out[1]!), "│ # not a heading");
  assert.equal(out[1]!.spans[1]!.role, "fence");
});

test("list markers and nesting produce indented bullets", () => {
  const out = lines("- one\n- two\n  - nested", 40);
  assert.equal(out[0], "• one");
  assert.equal(out[1], "• two");
  assert.equal(out[2], "  ◦ nested");
});

test("an ordered list keeps its numbers", () => {
  const out = lines("1. first\n2. second", 40);
  assert.equal(out[0], "1. first");
  assert.equal(out[1], "2. second");
});

test("task list items become checkboxes", () => {
  const out = lines("- [ ] todo\n- [x] done", 40);
  assert.equal(out[0], "☐ todo");
  assert.equal(out[1], "☑ done");
});

test("a blockquote is drawn with a gutter", () => {
  const out = lines("> quoted words", 40);
  assert.equal(out[0], "▌ quoted words");
});

test("a horizontal rule fills the width", () => {
  assert.equal(lines("---", 24)[0], "─".repeat(24));
});

test("the width is clamped to a readable minimum", () => {
  assert.equal(lines("---", 8)[0], "─".repeat(20));
});

test("a table is aligned into columns with a rule under the header", () => {
  const out = lines("| Name | Age |\n| --- | ---: |\n| Ada | 36 |\n| Bo | 7 |", 40);
  assert.match(out[0]!, /^Name {2}Age$/);
  assert.match(out[1]!, /^─+ {2}─+$/);
  assert.match(out[2]!, /^Ada {3}.*36$/);
  assert.equal(out.length, 4);
});

test("paragraphs wrap to the given width", () => {
  const out = lines("alpha bravo charlie delta echo foxtrot golf hotel", 20);
  assert.ok(out.length > 1);
  for (const line of out) assert.ok(line.length <= 20, `"${line}" is ${line.length} wide`);
});

test("width drives the wrap, so a resize re-renders differently", () => {
  const source = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  assert.ok(lines(source, 20).length > lines(source, 60).length);
});

test("front matter is shown rather than hidden", () => {
  const out = lines("---\ntitle: Hello\n---\n\nBody", 40);
  assert.equal(out[0], "▏ title: Hello");
  assert.equal(out.at(-1), "Body");
});

test("html comments are stripped", () => {
  assert.deepEqual(lines("<!-- hidden -->\nvisible", 40), ["visible"]);
});

test("wrapSpans hangs continuation lines under the first", () => {
  const out = wrapSpans(parseInline("one two three four five six"), 12, 0, 4);
  assert.equal(plain(out[0]!).startsWith(" "), false);
  assert.ok(plain(out[1]!).startsWith("    "));
});

test("a word longer than the line is cut, not lost", () => {
  const url = "https://example.com/a/very/long/path/that/never/ends/at/all";
  const out = wrapSpans(parseInline(url), 20);
  assert.equal(out.map(plain).join(""), url);
  for (const line of out) assert.ok(plain(line).length <= 20);
});

test("an empty document renders no lines", () => {
  assert.deepEqual(renderMarkdown("", 40), []);
});

test("trailing blank lines are trimmed", () => {
  assert.deepEqual(lines("text\n\n\n\n", 40), ["text"]);
});

test("indented code is framed like a fence", () => {
  const out = lines("text\n\n    indented();\n", 40);
  assert.equal(out.at(-1), "│ indented();");
});

test("html wrappers are folded away", () => {
  const out = lines('<p align="center">Hello <strong>there</strong></p>', 40);
  assert.deepEqual(out, ["Hello there"]);
});

test("html anchors and images become markdown", () => {
  const spans = parseInline('<a href="https://x.dev">site</a>');
  assert.equal(spans[0]!.text, "site");
  assert.equal(spans[0]!.role, "link");
  assert.match(plain({ spans: parseInline('<img src="a.png" alt="a cat">') }), /a cat/);
});

test("a paragraph of nothing but html is dropped", () => {
  assert.deepEqual(lines('<div class="x">\n</div>', 40), []);
});

test("generics inside inline code survive tag stripping", () => {
  const spans = parseInline("use `Array<string>` here");
  assert.equal(spans.find((s) => s.role === "code")?.text, "Array<string>");
});

test("html is not stripped inside a fence", () => {
  assert.equal(lines("```\n<div>keep me</div>\n```", 40)[1], "│ <div>keep me</div>");
});

test("entities are decoded", () => {
  assert.deepEqual(lines("a &lt;b&gt; &amp; c", 40), ["a <b> & c"]);
});

test("wrapped lines carry no trailing whitespace", () => {
  const source = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
  for (const line of lines(source, 24)) assert.equal(line, line.replace(/\s+$/, ""));
});
