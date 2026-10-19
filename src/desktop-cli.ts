/**
 * `readm3 edit [PATH...]` (or `readm3 --desktop [PATH...]`): open files and folders in
 * the readm3 desktop editor and give the shell back at once, the way `subl .` does. A
 * running editor takes them into its window; otherwise one starts.
 * `readm3 desktop install` fetches the app.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";

export const DESKTOP_USAGE = `Desktop editor
  readm3 edit [PATH...]                   Open files or folders in the readm3 desktop
                                          app and return (also: readm3 --desktop,
                                          readm3 desktop, readm3 subl, readm3 open).
                                          No path opens the editor as you left it.
                                          READM3_DESKTOP names the app's binary.
  readm3 desktop install                  Install or update the desktop app (Linux), or
                                          print the download for macOS and Windows.
`;

const RELEASES = "https://github.com/profullstack/readm3/releases/latest";
const commands = new Set(["edit", "subl", "open", "desktop"]);
export const isDesktopCommand = (argv: string[]) => (!!argv[0] && commands.has(argv[0])) || argv.includes("--desktop");

/** What a desktop invocation asks for: install the app, show help, or open these paths. */
export type DesktopRequest = { action: "install" } | { action: "help" } | { action: "open"; paths: string[] } | { action: "error"; message: string };
export function parseDesktopArgs(argv: string[]): DesktopRequest {
  const command = commands.has(argv[0] ?? "") ? argv[0] : undefined;
  const rest = (command ? argv.slice(1) : argv).filter((arg) => arg !== "--desktop");
  if (rest.includes("--help") || rest.includes("-h")) return { action: "help" };
  if (command === "desktop" && rest[0] === "install" && rest.length === 1) return { action: "install" };
  const option = rest.find((arg) => arg.startsWith("-"));
  if (option) return { action: "error", message: `unknown option for ${command ?? "--desktop"}: ${option}` };
  return { action: "open", paths: rest };
}

/** The download for this machine: the release asset for macOS and Windows, the installer on Linux. */
export function desktopDownload(platform: NodeJS.Platform, arch: string): string {
  if (platform === "darwin") return `${RELEASES}/download/readm3-mac-${arch === "arm64" ? "arm64" : "x64"}.dmg`;
  if (platform === "win32") return `${RELEASES}/download/readm3-windows-x64-setup.exe`;
  return "curl -fsSL https://readm3.com/install.sh | sh -s -- --desktop";
}

/** How to start the app: a binary and the arguments that come before the paths. */
export interface Launch { command: string; args: string[]; }

/**
 * Where an installed desktop app lives, most specific first: READM3_DESKTOP, the
 * `readm3-desktop` command (install.sh puts it on PATH), then each platform's
 * usual install location. The Flatpak is last, because only `flatpak run` starts it.
 */
export function desktopCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): Launch[] {
  // The platform's own path rules, so the lookup for one platform can be checked on another.
  const { delimiter, join } = platform === "win32" ? win32 : posix;
  const found: Launch[] = [];
  const binary = (command: string) => found.push({ command, args: [] });
  if (env.READM3_DESKTOP) binary(env.READM3_DESKTOP);
  const exe = platform === "win32" ? "readm3-desktop.exe" : "readm3-desktop";
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir) binary(join(dir, exe));
  if (platform === "darwin") {
    for (const apps of ["/Applications", join(home, "Applications")]) binary(join(apps, "readm3.app", "Contents", "MacOS", "readm3"));
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    binary(join(local, "Programs", "readm3", exe));
    if (env.ProgramFiles) binary(join(env.ProgramFiles, "readm3", exe));
  } else {
    const share = join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "readm3");
    binary(join(share, "desktop", "readm3-desktop"));
    binary(join(share, "readm3.AppImage"));
    for (const root of [join(home, ".local", "share", "flatpak"), "/var/lib/flatpak"]) {
      if (existsSync(join(root, "app", "com.readm3.Editor"))) found.push({ command: "flatpak", args: ["run", "com.readm3.Editor"] });
    }
  }
  return found;
}

/**
 * Bare `readm3 [PATH...]` opens the desktop editor when there is one to open: no switches
 * (they all belong to the terminal reader), a screen to draw on (not an SSH session on a
 * headless box), and the app installed. Otherwise it is the terminal reader, as it was.
 */
export function prefersDesktop(argv: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (argv.some((arg) => arg.startsWith("-"))) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}
export const installedDesktop = () => findDesktop(desktopCandidates(process.platform, process.env, homedir()));

export function findDesktop(candidates: Launch[], exists: (path: string) => boolean = existsSync): Launch | undefined {
  return candidates.find((launch) => launch.command === "flatpak" || exists(launch.command));
}

async function install(): Promise<void> {
  const download = desktopDownload(process.platform, process.arch);
  if (process.platform === "darwin" || process.platform === "win32") {
    process.stdout.write(`Download and run the readm3 desktop app for this machine:\n  ${download}\n`);
    return;
  }
  // The same installer as the website's: it verifies the release checksum and adds a menu entry.
  const code = await new Promise<number | null>((done, fail) => {
    const child = spawn("sh", ["-c", download], { stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", done);
  });
  if (code !== 0) process.exitCode = code ?? 1;
}

export async function desktopMain(argv: string[]): Promise<void> {
  const request = parseDesktopArgs(argv);
  if (request.action === "help") { process.stdout.write(DESKTOP_USAGE); return; }
  if (request.action === "install") { await install(); return; }
  if (request.action === "error") {
    process.stderr.write(`readm3: ${request.message}\n\n${DESKTOP_USAGE}`);
    process.exitCode = 2;
    return;
  }
  const launch = findDesktop(desktopCandidates(process.platform, process.env, homedir()));
  if (!launch) {
    process.stderr.write(`readm3: the desktop app is not installed. Install it with:\n  readm3 desktop install\n`);
    process.exitCode = 1;
    return;
  }
  // Absolute paths, so a running editor started somewhere else opens the right files.
  const paths = request.paths.map((path) => resolve(path));
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length) {
    process.stderr.write(`readm3: no such file or directory: ${missing.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  await new Promise<void>((done, fail) => {
    const child = spawn(launch.command, [...launch.args, ...paths], { detached: true, stdio: "ignore" });
    child.once("error", fail);
    child.once("spawn", () => { child.unref(); done(); });
  });
}
