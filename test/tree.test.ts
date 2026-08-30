import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterTree, files, flatten, indexOfPath, label, matches, reveal, scan } from "../src/tree.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "readm3-"));
  mkdirSync(join(root, "docs", "guides"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Root");
  writeFileSync(join(root, "alpha.md"), "# Alpha");
  writeFileSync(join(root, "docs", "intro.md"), "# Intro");
  writeFileSync(join(root, "docs", "guides", "getting-started.md"), "# Start");
  writeFileSync(join(root, "node_modules", "pkg", "README.md"), "# Nope");
  writeFileSync(join(root, "src", "index.ts"), "export {};");
  return root;
}

test("the scan finds markdown and skips ignored directories", () => {
  const root = fixture();
  try {
    const found = files(scan(root)).map((f) => f.name);
    assert.deepEqual(found.sort(), ["README.md", "alpha.md", "getting-started.md", "intro.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directories with no markdown beneath them are pruned", () => {
  const root = fixture();
  try {
    const names = scan(root).map((e) => e.name);
    assert.ok(!names.includes("src"), "src holds no markdown and should not appear");
    assert.ok(!names.includes("node_modules"));
    assert.ok(names.includes("docs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("README sorts first and directories lead the files", () => {
  const root = fixture();
  try {
    assert.deepEqual(scan(root).map((e) => e.name), ["docs", "README.md", "alpha.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flatten only descends into expanded directories", () => {
  const root = fixture();
  try {
    const entries = scan(root);
    const docs = entries.find((e) => e.name === "docs")!;
    docs.expanded = false;
    assert.deepEqual(flatten(entries).map((f) => f.entry.name), ["docs", "README.md", "alpha.md"]);
    docs.expanded = true;
    assert.ok(flatten(entries).map((f) => f.entry.name).includes("intro.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flatten records the parent so collapsing can walk upwards", () => {
  const root = fixture();
  try {
    const flat = flatten(scan(root));
    const intro = flat.find((f) => f.entry.name === "intro.md")!;
    assert.equal(flat[intro.parent]!.entry.name, "docs");
    assert.equal(flat[0]!.parent, -1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filtering keeps matching files and the directories above them", () => {
  const root = fixture();
  try {
    const filtered = filterTree(scan(root), "getting", root);
    assert.deepEqual(files(filtered).map((f) => f.name), ["getting-started.md"]);
    assert.equal(filtered[0]!.name, "docs");
    assert.equal(filtered[0]!.expanded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filtering does not mutate the tree it was given", () => {
  const root = fixture();
  try {
    const entries = scan(root);
    const before = flatten(entries).length;
    filterTree(entries, "intro", root);
    assert.equal(flatten(entries).length, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subsequence matches, an absent letter does not", () => {
  assert.equal(matches("docs/getting-started.md", "gst"), true);
  assert.equal(matches("docs/getting-started.md", "started"), true);
  assert.equal(matches("docs/getting-started.md", "zzz"), false);
  assert.equal(matches("abc", "cb"), false, "order matters");
});

test("reveal expands every directory on the way to a file", () => {
  const root = fixture();
  try {
    const entries = scan(root);
    const docs = entries.find((e) => e.name === "docs")!;
    docs.expanded = false;
    docs.children.find((c) => c.name === "guides")!.expanded = false;
    const target = join(root, "docs", "guides", "getting-started.md");
    assert.equal(reveal(entries, target), true);
    assert.ok(indexOfPath(flatten(entries), target) >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("label is the path relative to the root", () => {
  assert.equal(label("/a/b", "/a/b/docs/x.md"), join("docs", "x.md"));
  assert.equal(label("/a/b", "/elsewhere/x.md"), "x.md");
});
