/**
 * `readm3 edit [PATH...]`: open files and folders in the readm3 desktop editor and give
 * the shell back at once, the way `subl .` does. A running editor takes them into its
 * window; otherwise one starts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";

export const DESKTOP_USAGE = `Desktop editor
  readm3 edit [PATH...]                   Open files or folders in the readm3 desktop
                                          app and return (also: readm3 subl, readm3 open).
                                          No path opens the editor as you left it.
                                          READM3_DESKTOP names the app's binary.
  Install it: curl -fsSL https://readm3.com/install.sh | sh -s -- --desktop
  or download it from https://github.com/profullstack/readm3/releases/latest
`;

const commands = new Set(["edit", "subl", "open"]);
export const isDesktopCommand = (command: string | undefined) => !!command && commands.has(command);

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

export function findDesktop(candidates: Launch[], exists: (path: string) => boolean = existsSync): Launch | undefined {
  return candidates.find((launch) => launch.command === "flatpak" || exists(launch.command));
}

export async function desktopMain(argv: string[]): Promise<void> {
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) { process.stdout.write(DESKTOP_USAGE); return; }
  const option = rest.find((arg) => arg.startsWith("-"));
  if (option) {
    process.stderr.write(`readm3: unknown option for ${argv[0]}: ${option}\n\n${DESKTOP_USAGE}`);
    process.exitCode = 2;
    return;
  }
  const launch = findDesktop(desktopCandidates(process.platform, process.env, homedir()));
  if (!launch) {
    process.stderr.write(`readm3: the desktop app is not installed.\n\n${DESKTOP_USAGE}`);
    process.exitCode = 1;
    return;
  }
  // Absolute paths, so a running editor started somewhere else opens the right files.
  const paths = rest.map((path) => resolve(path));
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
