/**
 * Argument parsing and entry point. `readm3 --help` is the contract.
 */
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { themeList } from "@profullstack/hqtui";
import { run, type ViewerOptions } from "./viewer.ts";

export const VERSION = "0.1.1";

const USAGE = `readm3 — a terminal markdown reader

Usage
  readm3 [path] [options]

  path            A directory to browse, or a file to open. Defaults to the
                  current directory.

Options
  -t, --theme <name>   Color theme. One of: ${themeList.map((t) => t.name).join(", ")}
  -w, --width <n>      Sidebar width in columns. Default: 28% of the terminal
  -a, --all            Include dot-directories and dotfiles
  -M, --no-mouse       Disable mouse tracking
  -v, --version        Print the version
  -h, --help           Print this help

Keys
  up/down j k    move or scroll        tab      switch pane
  right/left l h expand or collapse    /        filter files
  enter          open the file         r        rescan and reload
  space / b      page down / up        [ ]      sidebar width
  g / G          top / bottom          ?        help
                                       q        quit
`;

export interface ParsedArgs extends ViewerOptions {
  help: boolean;
  version: boolean;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    root: process.cwd(),
    help: false,
    version: false,
    mouse: true,
    all: false,
  };
  let target: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      return value;
    };

    switch (arg) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "-v":
      case "--version":
        parsed.version = true;
        break;
      case "-t":
      case "--theme":
        parsed.theme = next();
        break;
      case "-w":
      case "--width": {
        const value = Number.parseInt(next(), 10);
        if (!Number.isFinite(value) || value <= 0) throw new UsageError("--width needs a positive number");
        parsed.sidebar = value;
        break;
      }
      case "-a":
      case "--all":
        parsed.all = true;
        break;
      case "-M":
      case "--no-mouse":
        parsed.mouse = false;
        break;
      default:
        if (arg.startsWith("-") && arg !== "-") throw new UsageError(`Unknown option: ${arg}`);
        if (target !== undefined) throw new UsageError("Only one path may be given");
        target = arg;
        break;
    }
  }

  if (target !== undefined) {
    const path = resolve(target);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      throw new UsageError(`No such file or directory: ${target}`);
    }
    if (isDir) {
      parsed.root = path;
    } else {
      parsed.root = dirname(path);
      parsed.open = path;
    }
  }

  return parsed;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`readm3: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!process.stdout.isTTY) {
    process.stderr.write("readm3: needs a terminal. Try `readm3 --help`.\n");
    process.exitCode = 1;
    return;
  }

  await run(args);
}

// Running the source directly (`bun src/cli.ts`, `node src/cli.ts`) should start
// the reader. The published bin calls `main` itself, so this stays quiet there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
