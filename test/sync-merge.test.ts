import { test } from "node:test";
import assert from "node:assert/strict";
import { digests, mergeWorkspaces } from "../src/sync-merge.ts";
import type { SyncedWorkspace } from "../src/sync-schema.ts";

const ws = (docs: Record<string, string>, name = "Your workspace"): SyncedWorkspace =>
  ({ name, active: Object.keys(docs)[0]!, documents: Object.entries(docs).map(([path, source]) => ({ path, source })) });
const paths = (w: SyncedWorkspace) => Object.fromEntries(w.documents.map((d) => [d.path, d.source]));
const starterDocs = { "Welcome.md": "# Welcome", "README.md": "# readm3", "examples/demo.md": "demo" };
const starter = digests(ws(starterDocs));

test("a new device with only the starter files takes the account workspace whole", () => {
  const account = ws({ "IRS.md": "taxes", "docs/a.md": "a" });
  const result = mergeWorkspaces({ local: ws(starterDocs, "readm3 / getting started"), remote: account, base: undefined, starter });
  assert.deepEqual(paths(result.workspace), paths(account));
  assert.equal(result.workspace.name, "Your workspace");
  assert.equal(result.upload, false, "the starter files are never uploaded over the account");
  assert.equal(result.download, true);
});

test("a new device keeps its own files beside the account's, and never overwrites one", () => {
  const result = mergeWorkspaces({ local: ws({ "mine.md": "x", "IRS.md": "local taxes" }), remote: ws({ "IRS.md": "taxes" }), base: undefined, conflictLabel: "desktop" });
  assert.deepEqual(paths(result.workspace), { "IRS (desktop).md": "local taxes", "IRS.md": "taxes", "mine.md": "x" });
  assert.deepEqual(result.conflicts, ["IRS (desktop).md"]);
  assert.equal(result.upload, true);
});

test("the first device to sync uploads everything", () => {
  const result = mergeWorkspaces({ local: ws({ "a.md": "a" }), remote: undefined, base: undefined });
  assert.deepEqual(paths(result.workspace), { "a.md": "a" });
  assert.equal(result.upload, true);
  assert.equal(result.download, false);
});

test("an edit on one side wins; an edit on both keeps a conflict copy", () => {
  const base = digests(ws({ "a.md": "1", "b.md": "1", "c.md": "1" }));
  const local = ws({ "a.md": "local", "b.md": "1", "c.md": "local" });
  const remote = ws({ "a.md": "1", "b.md": "remote", "c.md": "remote" });
  const result = mergeWorkspaces({ local, remote, base, conflictLabel: "conflict" });
  assert.deepEqual(paths(result.workspace), { "a.md": "local", "b.md": "remote", "c (conflict).md": "local", "c.md": "remote" });
  assert.equal(result.upload, true);
  assert.equal(result.download, true);
});

test("deletions carry over unless the other side edited the document", () => {
  const base = digests(ws({ "gone-here.md": "1", "gone-there.md": "1", "edited-there.md": "1", "edited-here.md": "1" }));
  const local = ws({ "gone-there.md": "1", "edited-here.md": "changed", "new-here.md": "n" });
  const remote = ws({ "gone-here.md": "1", "edited-there.md": "changed", "new-there.md": "n" });
  const result = mergeWorkspaces({ local, remote, base });
  assert.deepEqual(Object.keys(paths(result.workspace)).sort(), ["edited-here.md", "edited-there.md", "new-here.md", "new-there.md"]);
});

test("nothing changed anywhere means nothing to upload or apply", () => {
  const same = ws({ "a.md": "a", "b.md": "b" });
  const result = mergeWorkspaces({ local: same, remote: structuredClone(same), base: digests(same) });
  assert.equal(result.upload, false);
  assert.equal(result.download, false);
});

test("a conflict name never collides with an existing file", () => {
  const base = digests(ws({ "a.md": "1" }));
  const result = mergeWorkspaces({ local: ws({ "a.md": "L", "a (x).md": "old" }), remote: ws({ "a.md": "R", "a (x).md": "old" }), base: { ...base, "a (x).md": digests(ws({ "a (x).md": "old" }))["a (x).md"]! }, conflictLabel: "x" });
  assert.ok(result.conflicts[0] === "a (x 2).md", result.conflicts.join());
});
