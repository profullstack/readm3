import { pasteLocation } from "./cloud-client.ts";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  cloudAction,
  cloudConfig,
  cloudRequest,
  clearCloudConfig,
  saveCloudConfig,
  sharedLocation,
} from "./cloud-client.ts";
export const CLOUD_USAGE = `Shared Markdown
  readm3 login --token-stdin              Save a personal API token securely
  readm3 logout                           Remove the local token
  readm3 share FILE --org ID [--role view|edit]
  readm3 docs list [--org ID] [--search TEXT] [--limit N] [--offset N]
  readm3 docs get ID [--raw]
  readm3 docs create FILE --org ID [--title NAME]
  readm3 docs update ID FILE --base VERSION
  readm3 docs delete ID
  readm3 docs history ID
  readm3 docs restore ID --version VERSION --base CURRENT
  readm3 docs share ID [--role view|edit] [--version VERSION]
  readm3 docs revoke ID --share SHARE_ID
  readm3 docs transfer ID --username USERNAME
  readm3 shared get URL [--raw]
  readm3 paste [FILE] [--title NAME] [--expires 1h|1d|7d|30d]
                                          Private link, no account; prints the URL
  readm3 paste get URL [--raw] | delete URL
  readm3 shared update URL FILE --base VERSION
  readm3 orgs list | create --name NAME | update ID --name NAME | delete ID
  readm3 teams list --org ID | create --org ID --name NAME
  readm3 members list --org ID
  readm3 cloud OPERATION --args '{"key":"value"}'
  readm3 mcp                              Start the stdio MCP server

FILE may be - for stdin. --raw prints Markdown; other results are JSON.
READM3_URL selects a self-hosted server; READM3_TOKEN supplies an API token.
View links cannot write. Edit links can save versions. Owners administer files.
Use readm3 cloud for the full API, including team membership and permissions.
`;
const commands = new Set([
  "login",
  "logout",
  "share",
  "docs",
  "shared",
  "paste",
  "orgs",
  "teams",
  "members",
  "cloud",
  "mcp",
]);
export function isCloudCommand(command: string | undefined) {
  return !!command && commands.has(command);
}
export async function cloudMain(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(CLOUD_USAGE);
    return;
  }
  const command = argv[0];
  if (command === "mcp") {
    const { runMcp } = await import("./mcp.ts");
    await runMcp();
    return;
  }
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const value = argv[i]!;
    if (value.startsWith("--")) {
      const name = value.slice(2);
      if (["raw", "token-stdin", "json"].includes(name)) flags[name] = "true";
      else {
        if (!argv[i + 1] || argv[i + 1]!.startsWith("--"))
          throw new Error(`${value} needs a value.`);
        flags[name] = argv[++i]!;
      }
    } else positional.push(value);
  }
  const output = (value: unknown) =>
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  const fileSource = (file: string | undefined) => {
    if (!file) throw new Error("A Markdown file is required.");
    const value = readFileSync(file === "-" ? 0 : file, "utf8");
    if (Buffer.byteLength(value) > 1024 * 1024)
      throw new Error("Shared documents are limited to 1 MB.");
    return value;
  };
  if (command === "login") {
    if (!flags["token-stdin"])
      throw new Error(
        "Use --token-stdin and paste the API token, then end input (Ctrl+D). Tokens are created at /admin.",
      );
    const token = readFileSync(0, "utf8").trim();
    if (!token) throw new Error("No token supplied.");
    const config = cloudConfig(token);
    const user = await cloudAction("account_me", {}, config);
    saveCloudConfig(config);
    output({ signedIn: true, user });
    return;
  }
  if (command === "paste") {
    if (positional[0] === "get" || positional[0] === "delete") {
      if (!positional[1]) throw new Error("A paste URL is required.");
      const { token, config } = pasteLocation(positional[1]);
      if (positional[0] === "delete") {
        await cloudRequest(`pastes/${token}`, "DELETE", undefined, config);
        output({ deleted: true });
        return;
      }
      const paste = await cloudRequest<{ source: string }>(`pastes/${token}`, "GET", undefined, config);
      if (flags.raw) process.stdout.write(paste.source);
      else output(paste);
      return;
    }
    if (!positional[0] && process.stdin.isTTY)
      throw new Error("Give a Markdown file, or pipe one in.");
    const source = fileSource(positional[0] ?? "-");
    const paste = await cloudRequest<{ url: string }>(
      "pastes",
      "POST",
      { source, title: flags.title, expiresIn: flags.expires },
      cloudConfig(),
    );
    if (flags.json) output(paste);
    else process.stdout.write(paste.url + "\n");
    return;
  }
  if (command === "logout") {
    clearCloudConfig();
    output({
      signedOut: true,
      note: "Revoke the token in /admin to invalidate other copies.",
    });
    return;
  }
  if (command === "cloud") {
    if (!positional[0]) throw new Error(CLOUD_USAGE);
    const args = flags.args ? JSON.parse(flags.args) : {};
    output(await cloudAction(positional[0], args));
    return;
  }
  if (command === "shared") {
    const [verb, url, file] = positional;
    if (!["get", "update"].includes(verb!))
      throw new Error("Use shared get or shared update.");
    if (!url) throw new Error("A shared document URL is required.");
    const { token, config } = sharedLocation(url);
    const result = await cloudRequest<{ version: { source: string } }>(
      `shared/${token}`,
      verb === "update" ? "PATCH" : "GET",
      verb === "update"
        ? { source: fileSource(file), baseVersion: flags.base }
        : undefined,
      config,
    );
    if (!["get", "update"].includes(verb!))
      throw new Error("Use shared get or shared update.");
    if (flags.raw) process.stdout.write(result.version.source);
    else output(result);
    return;
  }
  const args: Record<string, unknown> = {};
  const names: Record<string, string> = {
    org: "orgId",
    team: "teamId",
    base: "baseVersion",
    version: "versionId",
    share: "shareId",
    user: "userId",
  };
  for (const [name, value] of Object.entries(flags))
    if (!["raw", "json"].includes(name)) args[names[name] || name] = value;
  if (command === "share") {
    const file = positional[0];
    const doc = await cloudAction<{ id: string }>("documents_create", {
      ...args,
      title: flags.title || basename(file || "Document.md"),
      source: fileSource(file),
    });
    output(
      await cloudAction("shares_create", {
        documentId: doc.id,
        role: flags.role || "view",
      }),
    );
    return;
  }
  const [verb, identifier, file] = positional;
  if (command === "docs") {
    const operations: Record<string, string> = {
      list: "documents_list",
      get: "documents_get",
      create: "documents_create",
      update: "documents_update",
      delete: "documents_delete",
      history: "versions_list",
      restore: "versions_restore",
      share: "shares_create",
      revoke: "shares_revoke",
      transfer: "documents_transfer",
    };
    const op = operations[verb!];
    if (!op) throw new Error(CLOUD_USAGE);
    if (verb === "create") {
      args.source = fileSource(identifier);
      args.title = flags.title || basename(identifier || "Document.md");
    } else if (verb !== "list") args.documentId = identifier;
    if (verb === "update") args.source = fileSource(file);
    const result = await cloudAction<{ version?: { source: string } }>(
      op,
      args,
    );
    if (flags.raw && result.version)
      process.stdout.write(result.version.source);
    else output(result);
    return;
  }
  const prefix = command === "orgs" ? "organizations" : command;
  if (!["list", "create", "update", "delete", "remove"].includes(verb!))
    throw new Error(CLOUD_USAGE);
  if (identifier)
    args[
      command === "orgs" ? "orgId" : command === "teams" ? "teamId" : "userId"
    ] = identifier;
  output(await cloudAction(`${prefix}_${verb}`, args));
}
