import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateWorkspace } from "../src/sync-schema.ts";

describe("synced workspace files", () => {
  test("any file the reader can show is a valid workspace path, not only Markdown", () => {
    const ws = validateWorkspace({
      name: "mine",
      active: "config.json",
      documents: [
        { path: "README.md", source: "# hi" },
        { path: "config.json", source: "{}" },
        { path: "docs/spec.pdf", source: "JVBERi0=" },
        { path: "deploy", source: "#!/bin/sh\n", language: "bash" },
      ],
    });
    assert.equal(ws.documents.length, 4);
    assert.equal(ws.documents[3]!.language, "bash");
  });

  test("still rejects hidden paths, duplicates, unknown keys and a bad language", () => {
    const base = { name: "x", active: "a.md" };
    assert.throws(() => validateWorkspace({ ...base, documents: [{ path: ".env", source: "" }], active: ".env" }), /invalid or duplicate/);
    assert.throws(() => validateWorkspace({ ...base, documents: [{ path: "a.md", source: "" }, { path: "a.md", source: "" }] }), /invalid or duplicate/);
    assert.throws(() => validateWorkspace({ ...base, documents: [{ path: "a.md", source: "", encoding: "base64" }] }), /path, source and language/);
    assert.throws(() => validateWorkspace({ ...base, documents: [{ path: "a.md", source: "", language: "not a language!" }] }), /language must be/);
  });
});
