import { test } from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { desktopCandidates, desktopDownload, findDesktop, isDesktopCommand, parseDesktopArgs, prefersDesktop } from "../src/desktop-cli.ts";
import { USAGE } from "../src/cli.ts";

const { join } = posix;

test("edit, subl, open, desktop and --desktop reach the desktop app", () => {
  for (const name of ["edit", "subl", "open", "desktop"]) assert.equal(isDesktopCommand([name]), true);
  assert.equal(isDesktopCommand(["--desktop"]), true);
  assert.equal(isDesktopCommand([".", "--desktop"]), true);
  assert.equal(isDesktopCommand(["paste"]), false);
  assert.equal(isDesktopCommand([]), false);
  assert.match(USAGE, /readm3 edit \[PATH\.\.\.\]/);
  assert.match(USAGE, /readm3 desktop install/);
});

test("desktop arguments: paths, install, help and unknown options", () => {
  assert.deepEqual(parseDesktopArgs(["--desktop"]), { action: "open", paths: [] });
  assert.deepEqual(parseDesktopArgs(["--desktop", "."]), { action: "open", paths: ["."] });
  assert.deepEqual(parseDesktopArgs(["edit", "a.md", "src"]), { action: "open", paths: ["a.md", "src"] });
  assert.deepEqual(parseDesktopArgs(["desktop", "install"]), { action: "install" });
  // A file called "install" still opens through edit.
  assert.deepEqual(parseDesktopArgs(["edit", "install"]), { action: "open", paths: ["install"] });
  assert.deepEqual(parseDesktopArgs(["desktop", "-h"]), { action: "help" });
  assert.equal(parseDesktopArgs(["edit", "-w", "a.md"]).action, "error");
});

test("bare readm3 means the desktop only with paths alone and a display", () => {
  assert.equal(prefersDesktop([], "linux", { DISPLAY: ":0" }), true);
  assert.equal(prefersDesktop([".", "a.md"], "linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
  assert.equal(prefersDesktop([], "linux", {}), false, "SSH to a headless box keeps the terminal reader");
  assert.equal(prefersDesktop(["--theme", "nord"], "linux", { DISPLAY: ":0" }), false);
  assert.equal(prefersDesktop(["-p", "a.md"], "darwin", {}), false);
  assert.equal(prefersDesktop([], "darwin", {}), true);
  assert.match(USAGE, /readm3 tui \[path\]/);
});

test("the download matches the machine", () => {
  assert.match(desktopDownload("darwin", "arm64"), /readm3-mac-arm64\.dmg$/);
  assert.match(desktopDownload("darwin", "x64"), /readm3-mac-x64\.dmg$/);
  assert.match(desktopDownload("win32", "x64"), /setup\.exe$/);
  assert.match(desktopDownload("linux", "x64"), /install\.sh \| sh -s -- --desktop$/);
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
  assert.ok(win.includes(win32.join("C:/Users/a/AppData/Local", "Programs", "readm3", "readm3-desktop.exe")));
});

test("the first candidate that exists is used, and none means not installed", () => {
  const candidates = [{ command: "/a", args: [] }, { command: "/b", args: [] }];
  assert.equal(findDesktop(candidates, (path) => path === "/b")?.command, "/b");
  assert.equal(findDesktop(candidates, () => false), undefined);
});
