import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveKey, envelopeProblem, newKdf, open, seal, WrongPassphrase, type Kdf } from "../src/sync-crypto.ts";

// Fewer iterations keep the suite fast; the format and checks are the same.
const quick = (): Kdf => ({ ...newKdf(), iterations: 100_000 });

test("a sealed workspace opens with the same passphrase and is compressed", async () => {
  const kdf = quick();
  const key = await deriveKey("correct horse battery", kdf);
  const files = { "workspace.json": { content: "# Notes\n".repeat(5000) }, "settings.json": { content: "{}" } };
  const envelope = await seal(files, key);
  assert.equal(envelopeProblem(envelope), null);
  assert.ok(envelope.data.length < JSON.stringify(files).length / 10, `compressed: ${envelope.data.length}`);
  assert.ok(!envelope.data.includes("Notes") && !JSON.stringify(envelope).includes("workspace"), "nothing readable in the envelope");
  // Another device: same passphrase, salt from the envelope.
  const other = await deriveKey("correct horse battery", envelope.kdf);
  assert.deepEqual(await open(envelope, other), files);
});

test("a wrong passphrase is refused, not decoded into garbage", async () => {
  const kdf = quick();
  const envelope = await seal({ a: 1 }, await deriveKey("right passphrase", kdf));
  await assert.rejects(open(envelope, await deriveKey("wrong passphrase", kdf)), WrongPassphrase);
});

test("tampering is detected", async () => {
  const key = await deriveKey("right passphrase", quick());
  const envelope = await seal({ a: 1 }, key);
  const flipped = { ...envelope, data: (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1) };
  await assert.rejects(open(flipped, key), WrongPassphrase);
});

test("every seal uses a fresh iv", async () => {
  const key = await deriveKey("right passphrase", quick());
  assert.notEqual((await seal({ a: 1 }, key)).iv, (await seal({ a: 1 }, key)).iv);
});

test("the server's shape check rejects anything but an envelope", async () => {
  assert.match(envelopeProblem({ v: 1, alg: "none" }) ?? "", /unsupported/);
  assert.match(envelopeProblem({ ...(await seal({}, await deriveKey("x".repeat(10), quick()))), extra: 1 }) ?? "", /unknown fields/);
  assert.match(envelopeProblem("x") ?? "", /object/);
});
