import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blobRefProblem, CHUNK_BYTES, chunkCount, chunkStoredBytes, decryptChunk, encryptChunk, MAX_BLOB_BYTES, newBlobRef, storedBytes, TAG_BYTES,
} from "../src/blob-store.ts";
import { validateWorkspace } from "../src/sync-schema.ts";
import { digestDocument, mergeWorkspaces } from "../src/sync-merge.ts";

test("a stored file is encrypted per chunk, and a chunk only opens at its own position", async () => {
  const ref = newBlobRef(10);
  assert.equal(blobRefProblem(ref), null);
  const plain = new TextEncoder().encode("0123456789");
  const sealed = await encryptChunk(ref, 0, plain);
  assert.equal(sealed.byteLength, plain.byteLength + TAG_BYTES);
  assert.deepEqual(await decryptChunk(ref, 0, sealed), plain);
  await assert.rejects(decryptChunk(ref, 1, sealed), /failed to decrypt/);
  await assert.rejects(decryptChunk(newBlobRef(10), 0, sealed), /failed to decrypt/);
});

test("chunk arithmetic covers a 5 GB file exactly", () => {
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkCount(CHUNK_BYTES), 1);
  assert.equal(chunkCount(CHUNK_BYTES + 1), 2);
  assert.equal(chunkCount(MAX_BLOB_BYTES), 640);
  assert.equal(chunkStoredBytes(CHUNK_BYTES + 1, 1), 1 + TAG_BYTES);
  assert.equal(storedBytes(MAX_BLOB_BYTES), MAX_BLOB_BYTES + 640 * TAG_BYTES);
  assert.match(blobRefProblem({ ...newBlobRef(1), size: MAX_BLOB_BYTES + 1 })!, /5 GB/);
  assert.match(blobRefProblem({ ...newBlobRef(1), id: "../../etc" })!, /invalid id/);
});

test("a synced workspace holds up to 5,000 files and carries stored files by reference", () => {
  const documents = Array.from({ length: 4999 }, (_, i) => ({ path: `notes/${i}.md`, source: `# ${i}` }));
  documents.push({ path: "big/dump.json", source: "", blob: newBlobRef(3 * 1024 ** 3) } as never);
  assert.equal(validateWorkspace({ name: "Many", active: "notes/0.md", documents }).documents.length, 5000);
  documents.push({ path: "one/more.md", source: "" });
  assert.throws(() => validateWorkspace({ name: "Many", active: "notes/0.md", documents }), /1–5,000 files/);
  assert.throws(() => validateWorkspace({ name: "x", active: "a.md", documents: [{ path: "a.md", source: "text", blob: newBlobRef(1) }] }), /source must be empty/);
});

test("a spilled file compares equal to its inline copy, so moving it never looks like an edit", () => {
  const inline = { path: "a.md", source: "# hello" };
  const spilled = { path: "a.md", source: "", blob: newBlobRef(7, digestDocument(inline)) };
  assert.equal(digestDocument(spilled), digestDocument(inline));
  const merge = mergeWorkspaces({
    local: { name: "w", active: "a.md", documents: [inline] },
    remote: { name: "w", active: "a.md", documents: [spilled] },
    base: { "a.md": digestDocument(inline) },
  });
  assert.equal(merge.upload, false);
  assert.equal(merge.download, false);
  const large = newBlobRef(9 * 1024 * 1024);
  assert.notEqual(digestDocument({ source: "", blob: large }), digestDocument({ source: "", blob: newBlobRef(large.size) }));
});
