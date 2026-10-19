import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { desktopCandidates, findDesktop, isDesktopCommand } from "../src/desktop-cli.ts";
import { USAGE } from "../src/cli.ts";

test("edit, subl and open are the desktop commands", () => {
  for (const name of ["edit", "subl", "open"]) assert.equal(isDesktopCommand(name), true);
  assert.equal(isDesktopCommand("paste"), false);
  assert.equal(isDesktopCommand(undefined), false);
  assert.match(USAGE, /readm3 edit \[PATH\.\.\.\]/);
});

test("READM3_DESKTOP wins, then readm3-desktop on PATH", () => {
  const found = desktopCandidates("linux", { READM3_DESKTOP: "/opt/r3", PATH: "/usr/bin:/home/a/.local/bin" }, "/home/a");
  assert.deepEqual(found.slice(0, 3).map((launch) => launch.command), ["/opt/r3", join("/usr/bin", "readm3-desktop"), join("/home/a/.local/bin", "readm3-desktop")]);
});

test("Linux falls back to where install.sh puts the app", () => {
  const found = desktopCandidates("linux", { PATH: "" }, "/home/a").map((launch) => launch.command);
  assert.deepEqual(found.slice(0, 2), ["/home/a/.local/share/readm3/desktop/readm3-desktop", "/home/a/.local/share/readm3/readm3.AppImage"]);
});

test("macOS and Windows look in their install folders", () => {
  const mac = desktopCandidates("darwin", { PATH: "" }, "/Users/a").map((launch) => launch.command);
  assert.ok(mac.includes(join("/Applications", "readm3.app", "Contents", "MacOS", "readm3")));
  const win = desktopCandidates("win32", { PATH: "", LOCALAPPDATA: "C:/Users/a/AppData/Local" }, "C:/Users/a").map((launch) => launch.command);
  assert.ok(win.includes(join("C:/Users/a/AppData/Local", "Programs", "readm3", "readm3-desktop.exe")));
});

test("the first candidate that exists is used, and none means not installed", () => {
  const candidates = [{ command: "/a", args: [] }, { command: "/b", args: [] }];
  assert.equal(findDesktop(candidates, (path) => path === "/b")?.command, "/b");
  assert.equal(findDesktop(candidates, () => false), undefined);
});
