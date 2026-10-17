#!/usr/bin/env node
/**
 * Builds the desktop packages: `node build.mjs [AppImage] [flatpak]` (both by default).
 *
 * The version is readm3's own (../package.json), the editor inside is the site build
 * (../site/dist, built here if missing), and after packing, resources/launch.sh takes
 * the Electron binary's place so the sandbox is chosen before Chromium starts.
 * The Flatpak target needs flatpak and flatpak-builder with the Flathub remote added.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const root = join(here, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["AppImage", "flatpak"];

// electron-builder stages an unpacked app plus a squashfs in the temp directory;
// keep that off a RAM-backed /tmp.
process.env.TMPDIR ||= join(homedir(), ".cache", "readm3-desktop-build");
mkdirSync(process.env.TMPDIR, { recursive: true });

if (!existsSync(join(root, "site/dist/viewer/index.html"))) {
  execFileSync("bun", ["run", "site:build"], { cwd: root, stdio: "inherit" });
}

const { build, Platform } = await import("electron-builder");
await build({
  targets: Platform.LINUX.createTarget(targets),
  publish: "never",
  config: {
    extraMetadata: { version },
    // The launcher runs first and starts readm3-desktop.bin, the real Electron binary.
    afterPack: async ({ appOutDir, packager }) => {
      const binary = join(appOutDir, packager.executableName);
      renameSync(binary, `${binary}.bin`);
      copyFileSync(join(here, "resources/launch.sh"), binary);
      chmodSync(binary, 0o755);
    },
  },
});
console.log(`readm3 desktop ${version}: ${targets.join(", ")} in ${join(here, "release")}`);
