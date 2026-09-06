import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseArgs, USAGE, VERSION } from "../src/cli.ts";
import { FLAVORS } from "../src/flavors.ts";

test("no arguments browse the working directory", () => {
  const args = parseArgs([]);
  assert.equal(args.root, process.cwd());
  assert.equal(args.open, undefined);
  assert.equal(args.mouse, true);
});

test("flags are parsed", () => {
  const args = parseArgs(["--theme", "nord", "--width", "30", "--all", "--no-mouse"]);
  assert.equal(args.theme, "nord");
  assert.equal(args.sidebar, 30);
  assert.equal(args.all, true);
  assert.equal(args.mouse, false);
});

test("short flags match the long ones", () => {
  const args = parseArgs(["-t", "dracula", "-w", "24", "-a", "-M"]);
  assert.equal(args.theme, "dracula");
  assert.equal(args.sidebar, 24);
  assert.equal(args.all, true);
  assert.equal(args.mouse, false);
});

test("a file argument opens it and roots the browser at its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "readm3-cli-"));
  const file = join(dir, "x.md");
  writeFileSync(file, "# x");
  try {
    const args = parseArgs([file]);
    assert.equal(args.open, file);
    assert.equal(args.root, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bad input is rejected", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["--width", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--theme"]), /needs a value/);
  assert.throws(() => parseArgs(["/no/such/path/here"]), /No such file/);
});

test("help and version are recognised", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-v"]).version, true);
});

test("the reported version matches the package", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version, "bump VERSION in src/cli.ts alongside package.json");
});

test("--print and --color are parsed", () => {
  const args = parseArgs(["--print", "--color", "never"]);
  assert.equal(args.print, true);
  assert.equal(args.color, "never");
  assert.equal(args.open, undefined, "no path means stdin");
});

test("-p is short for --print and defaults to auto color", () => {
  assert.equal(parseArgs(["-p"]).print, true);
  assert.equal(parseArgs(["-p"]).color, "auto");
});

test('"-" is a path only in print mode', () => {
  assert.equal(parseArgs(["--print", "-"]).print, true);
  assert.throws(() => parseArgs(["-"]), /only makes sense with --print/);
});

test("--print refuses a directory and a bad color", () => {
  assert.throws(() => parseArgs(["--print", process.cwd()]), /needs a file/);
  assert.throws(() => parseArgs(["--color", "pink"]), /must be one of/);
});

test("--flavor takes any known dialect", () => {
  for (const flavor of FLAVORS) {
    assert.equal(parseArgs(["--flavor", flavor]).flavor, flavor);
  }
  assert.equal(parseArgs(["-f", "reddit"]).flavor, "reddit");
});

test("--flavor defaults to unset, so the renderer picks github", () => {
  assert.equal(parseArgs([]).flavor, undefined);
});

test("--flavor refuses a dialect nobody implements", () => {
  assert.throws(() => parseArgs(["--flavor", "mediawiki"]), /must be one of/);
  assert.throws(() => parseArgs(["--flavor"]), /needs a value/);
});

test("--spoilers and --read-only are off unless asked for", () => {
  const off = parseArgs([]);
  assert.equal(off.spoilers, false);
  assert.equal(off.readOnly, false);
  assert.equal(parseArgs(["--spoilers"]).spoilers, true);
  assert.equal(parseArgs(["--read-only"]).readOnly, true);
  assert.equal(parseArgs(["-R"]).readOnly, true);
});

test("the usage text names every flavor it accepts", () => {
  for (const flavor of FLAVORS) assert.match(USAGE, new RegExp(flavor));
});
