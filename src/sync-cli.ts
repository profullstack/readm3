import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { applyFiles, planApply } from "@profullstack/synconfig";
import { configDir, credentials, writeConfig } from "./account.ts";
import { loadSettings, localSettings, saveSettings, syncContext, syncStatus } from "./settings-sync.ts";
import { validateWorkspace, type SyncedWorkspace } from "./sync-schema.ts";
import { files, scan } from "./tree.ts";
import { isFlavor } from "./flavors.ts";
import { themeList } from "@profullstack/hqtui";

export const ACCOUNT_USAGE = `Account and sync commands
  readm3 whoami                         Show the verified account
  readm3 settings [--theme NAME] [--flavor NAME]
  readm3 save [file-or-directory] [--force]
  readm3 load [output-directory] [--dry-run] [--force]
  readm3 sync [status | save | load | revisions]

Save includes settings.json and the last imported workspace.json only.
Giving save a path imports its Markdown files. Load optionally writes them to
an output directory, backing up replaced files. --force explicitly resolves a
conflict. Credentials are stored separately and never synced.
READM3_API_URL, READM3_TOKEN and READM3_CONFIG_DIR override local defaults.
`;

function importWorkspace(target: string): SyncedWorkspace {
  const path = resolve(target);
  const directory = statSync(path).isDirectory();
  const root = directory ? path : dirname(path);
  const paths = directory ? files(scan(root)).map((entry) => entry.path) : [path];
  let bytes = 0;
  const documents = paths.map((file) => {
    const size = statSync(file).size;
    bytes += size;
    if (size > 4 * 1024 * 1024 || bytes > 20 * 1024 * 1024) throw new Error("Workspace limit: 4 MB per file and 20 MB total.");
    return { path: relative(root, file).split(sep).join("/"), source: readFileSync(file, "utf8") };
  });
  return validateWorkspace({ name: basename(root), documents, active: documents[0]?.path });
}

function exportWorkspace(ws: SyncedWorkspace, output: string, force: boolean, dryRun: boolean) {
  const root = resolve(output);
  const data = Object.fromEntries(ws.documents.map((doc) => [doc.path, { content: doc.source }]));
  // The library writes relative paths; reject symlink parents before handing it
  // any workspace paths, so a remote document cannot escape the chosen folder.
  for (const path of Object.keys(data)) {
    let current = join(root, path);
    while (true) {
      try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Refusing a symlink in output path: ${current}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current === root) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const plan = planApply(root, data);
  if (dryRun) return { plan };
  if (!force && plan.some((entry) => entry.status === "changed")) throw new Error("Output files differ. Use a new directory, or --force to replace them with numbered backups.");
  const backups: { path: string; backup: string }[] = [];
  const written = applyFiles(root, data, plan, { onBackup: (path, backup) => backups.push({ path, backup }) });
  return { written, backups };
}

export async function accountCommand(argv: string[]): Promise<boolean> {
  const commands = ["whoami", "settings", "save", "load", "sync"];
  if (!commands.includes(argv[0] || "")) return false;
  let [command, ...args] = argv;
  if (args.includes("--help") || args.includes("-h")) { process.stdout.write(ACCOUNT_USAGE); return true; }
  if (command === "sync") command = args[0] && !args[0].startsWith("-") ? args.shift()! : "status";
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["--force", "--dry-run"].includes(args[i])) options[args[i].slice(2)] = true;
    else if (["--theme", "--flavor"].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${args[i]} needs a value.`);
      options[args[i].slice(2)] = args[++i];
    } else if (args[i].startsWith("-")) throw new Error(`Unknown option: ${args[i]}`);
    else positional.push(args[i]);
  }
  if (positional.length > 1 || (positional.length && !["save", "load"].includes(command))) throw new Error("Unexpected positional argument. Run `readm3 sync --help`.");
  const allowed: Record<string, string[]> = { settings: ["theme", "flavor"], save: ["force"], load: ["force", "dry-run"] };
  for (const option of Object.keys(options)) if (!(allowed[command] || []).includes(option)) throw new Error(`--${option} is not supported by ${command}.`);
  let result: unknown;
  switch (command) {
    case "whoami": { const account = await credentials(); result = { user: account.user, api: account.api }; break; }
    case "settings": {
      const settings = localSettings();
      if (typeof options.theme === "string") {
        if (!themeList.some((theme) => theme.name === options.theme)) throw new Error("Unknown theme.");
        settings.theme = options.theme;
      }
      if (typeof options.flavor === "string") {
        if (!isFlavor(options.flavor)) throw new Error("Unknown flavor.");
        settings.flavor = options.flavor;
      }
      if (options.theme || options.flavor) writeConfig("settings.json", settings);
      result = settings; break;
    }
    case "save": {
      const ctx = await syncContext();
      if (positional[0]) writeConfig("workspace.json", importWorkspace(positional[0]));
      if (!existsSync(join(configDir(), "settings.json"))) writeConfig("settings.json", {});
      result = await saveSettings(ctx, { force: Boolean(options.force) }); break;
    }
    case "load": {
      const ctx = await syncContext();
      const latest = await ctx.client.get();
      const fixed = { ...ctx, client: { ...ctx.client, get: async () => latest } };
      const ws = latest?.snapshot.files["workspace.json"];
      // Check output paths before updating the local marker or config files.
      if (positional[0] && ws) {
        const plan = exportWorkspace(validateWorkspace(JSON.parse(ws.content)), positional[0], Boolean(options.force), true);
        if (!options.force && !options["dry-run"] && plan.plan!.some((entry) => entry.status === "changed")) throw new Error("Output files differ. Use a new directory or --force (with backups).");
      }
      const loaded = await loadSettings(fixed, { force: Boolean(options.force), dryRun: Boolean(options["dry-run"]) });
      result = loaded;
      if (positional[0] && ws && ["loaded", "same", "planned"].includes(loaded.status)) result = { ...loaded, output: exportWorkspace(validateWorkspace(JSON.parse(ws.content)), positional[0], Boolean(options.force), Boolean(options["dry-run"])) };
      break;
    }
    case "status": result = await syncStatus(await syncContext()); break;
    case "revisions": result = await (await syncContext()).client.revisions(); break;
    default: throw new Error(`Unknown sync command: ${command}`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result && typeof result === "object" && "status" in result && ["conflict", "local_changes", "newer"].includes(String(result.status))) process.exitCode = 1;
  return true;
}
