import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, snippet } from "../src/diff.ts";

test("identical text has no hunks", () => {
  assert.deepEqual(diffLines("a\nb\n", "a\nb\n"), { hunks: [], added: 0, removed: 0 });
});

test("a changed line in the middle is one hunk at its line", () => {
  const diff = diffLines("one\ntwo\nthree\n", "one\n2\nthree\n");
  assert.deepEqual(diff.hunks, [{ oldStart: 2, newStart: 2, removed: ["two"], added: ["2"] }]);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test("separate edits are separate hunks, aligned around kept lines", () => {
  const before = ["a", "b", "c", "d", "e", "f"].join("\n");
  const after = ["a", "B", "c", "d", "e", "f", "g"].join("\n");
  const diff = diffLines(before, after);
  assert.deepEqual(diff.hunks.map((h) => [h.oldStart, h.removed, h.added]), [[2, ["b"], ["B"]], [7, [], ["g"]]]);
});

test("insertions inside the middle keep the common lines between them", () => {
  const diff = diffLines("x\n1\n2\n3\ny", "x\n1\nnew\n2\n3\nmore\ny");
  assert.deepEqual(diff.hunks.map((h) => [h.newStart, h.added, h.removed]), [[3, ["new"], []], [6, ["more"], []]]);
});

test("a new file is all additions, a cleared one all removals", () => {
  assert.equal(diffLines("", "a\nb").added, 2);
  assert.equal(diffLines("a\nb", "").removed, 2);
});

test("CRLF and LF compare as the same lines", () => {
  assert.equal(diffLines("a\r\nb", "a\nb").hunks.length, 0);
});

test("a middle too large to align is reported as replaced, quickly", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
  const started = performance.now();
  const diff = diffLines(before, after);
  assert.ok(performance.now() - started < 500);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.removed, 3000);
});

test("snippets mark lines and stop at the limit", () => {
  const diff = diffLines("a\nb\nc", "a\nB\nC\nD");
  assert.deepEqual(snippet(diff, 3), ["- b", "- c", "+ B"]);
  assert.equal(snippet(diffLines("", "x".repeat(300)))[0]!.length, 120);
});
