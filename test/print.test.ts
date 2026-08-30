import { test } from "node:test";
import assert from "node:assert/strict";
import { hex, resolveTheme } from "@profullstack/hqtui";
import { mergeSpans, renderMarkdown, toText } from "../src/markdown.ts";
import { colorParams, renderAnsi, resolveDepth, resolveWidth, styleSpan } from "../src/print.ts";

const ESC = String.fromCharCode(27);
const theme = resolveTheme("dark");

test("with color off, printing is exactly the plain text", () => {
  const source = "# Title\n\nSome **bold** text.\n\n- one\n- two";
  const printed = renderAnsi(source, 40, theme, "none");
  assert.equal(printed, toText(renderMarkdown(source, 40)).join("\n"));
});

test("a span with no color is returned untouched", () => {
  assert.equal(styleSpan({ text: "hello" }, theme, "none"), "hello");
});

test("truecolor emits the exact channels of the theme color", () => {
  const out = styleSpan({ text: "x", role: "h1" }, theme, "truecolor");
  const c = theme.title;
  const [r, g, b] = [(c >>> 16) & 255, (c >>> 8) & 255, c & 255];
  assert.equal(out, `${ESC}[38;2;${r};${g};${b}mx${ESC}[0m`);
});

test("the color encoding is a plain packed rgb triple", () => {
  assert.deepEqual(colorParams(hex("#102030"), "truecolor"), ["38", "2", "16", "32", "48"]);
});

test("lower depths use the indexed forms", () => {
  assert.equal(colorParams(hex("#102030"), "ansi256")[1], "5");
  assert.equal(colorParams(hex("#ffffff"), "ansi16").length, 1);
  assert.deepEqual(colorParams(hex("#102030"), "none"), []);
});

test("attributes are emitted before the color", () => {
  const out = styleSpan({ text: "x", bold: true, underline: true }, theme, "truecolor");
  assert.match(out, new RegExp(`^\\${ESC}\\[1;4;38;2;`));
});

test("every span resets, so styling cannot leak down the pipe", () => {
  const printed = renderAnsi("**bold** then plain", 40, theme, "truecolor");
  assert.ok(printed.endsWith(`${ESC}[0m`));
});

test("--color never wins over the environment", () => {
  assert.equal(resolveDepth("never"), "none");
});

test("--color always still produces color", () => {
  assert.notEqual(resolveDepth("always"), "none");
});

test("an explicit width beats the terminal, and zero falls back", () => {
  assert.equal(resolveWidth(33), 33);
  assert.equal(resolveWidth(0) > 0, true);
});

test("trailing padding is trimmed so output is pipe-friendly", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 22222 |";
  for (const line of renderAnsi(table, 40, theme, "none").split("\n")) {
    assert.equal(line, line.replace(/\s+$/, ""));
  }
});

test("wrapping does not leave one span per word", () => {
  const line = renderMarkdown("alpha bravo charlie delta echo", 40)[0]!;
  assert.equal(line.spans.length, 1, "a plain sentence is one run");
});

test("mergeSpans joins matching neighbours and keeps the rest apart", () => {
  const merged = mergeSpans([
    { text: "a" },
    { text: "b" },
    { text: "c", bold: true },
    { text: "d", bold: true },
    { text: "e" },
  ]);
  assert.deepEqual(merged.map((s) => s.text), ["ab", "cd", "e"]);
});

test("merging does not change the visible text", () => {
  const source = "# H\n\nsome *mixed* `styles` and [a link](x) in a longer wrapped sentence here";
  const plainLines = toText(renderMarkdown(source, 30)).map((l) => l.replace(/\s+$/, ""));
  assert.equal(plainLines.join("\n"), renderAnsi(source, 30, theme, "none"));
});
