import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { cloudAction, cloudRequest, pasteLocation, sharedLocation } from "./cloud-client.ts";
import { queryTable } from "./csv.ts";
const string = { type: "string" };
const role = { type: "string", enum: ["view", "edit"] };
const definitions: [string, string, Record<string, unknown>, string[]][] = [
  ["paste_create", "Create an anonymous paste: any text file behind a secret link, no account needed. Markdown renders as a document; code (JSON, JavaScript, Python, YAML, SQL and 30 more) is highlighted with folding. The language is detected from the title's extension, else from the content; pass language to force one. Expires after 7 days by default (1h, 1d, 7d or 30d), 256 KB at most. Returns the URL and a raw URL; keep them, the server cannot show them again. The result's sensitive field lists any key, token, password, email address, public IP or named home directory in what the link exposes (secrets masked); when its level is \"secret\", tell the user before passing the link on.", { source: string, title: { type: "string", description: "A file name; its extension decides the language." }, language: { type: "string", description: "A highlight.js name such as json, javascript, python, bash, yaml or markdown. Detected when omitted." }, expiresIn: { type: "string", enum: ["1h", "1d", "7d", "30d"] } }, ["source"]],
  ["table_query", "Read a CSV or TSV the way the readm3 table view does, without loading it all into context. Give exactly one of source (the text), path (a local file) or url (a readm3 paste link or a raw http(s) file URL). The delimiter, header row and column types (number, date, boolean, text) are detected. filter keeps rows matching every space-separated term: free text, col:text, col=v, col!=v, col>n, col>=n, col<n, col<=n, #3 for the third column, ! to negate, quotes for spaces (city:\"new york\"). sort orders by a column name or number, empties last. Returns columns, total and matched counts, up to limit rows (default 50, max 1000) from offset as objects keyed by column name with their 1-based row number, and with stats a column's count, empty, distinct, min, max, sum, mean, median and top values over the matched rows.", { source: string, path: string, url: string, filter: string, sort: string, descending: { type: "boolean" }, limit: { type: "integer", minimum: 0, maximum: 1000 }, offset: { type: "integer", minimum: 0 }, stats: string }, []],
  ["paste_get", "Read an anonymous paste by its URL. Returns the source with its title, language and mime type.", { url: string }, ["url"]],
  ["paste_delete", "Delete an anonymous paste by its URL. The link stops working for everyone.", { url: string }, ["url"]],
  ["settings_get", "Read the verified account's latest settings and Markdown workspace snapshot, including its revision.", {}, []],
  ["settings_save", "Save settings.json and workspace.json. Use the revision from settings_get, or 0 for a first save. Stale saves are rejected.", {
    snapshot: { type: "object", properties: { version: { type: "integer", const: 1 }, files: { type: "object", description: "Only settings.json and workspace.json, each containing a JSON string in its content property." } }, required: ["version", "files"] },
    ifRevision: { type: "integer", minimum: 0 },
  }, ["snapshot", "ifRevision"]],
  ["settings_revisions", "List the verified account's last ten sync revisions.", {}, []],
  ["account_me", "Show the authenticated readm3 user, with any linked sign-in identities (CoinPay) under identities.", {}, []],
  ["organizations_list", "List organizations you belong to.", {}, []],
  [
    "organizations_create",
    "Create an organization owned by you.",
    { name: string },
    ["name"],
  ],
  [
    "organizations_update",
    "Rename an organization. Organization owner only.",
    { orgId: string, name: string },
    ["orgId", "name"],
  ],
  [
    "organizations_delete",
    "Delete an empty organization. Organization owner only.",
    { orgId: string },
    ["orgId"],
  ],
  ["members_list", "List organization members.", { orgId: string }, ["orgId"]],
  [
    "members_update",
    "Change membership role. Organization owner only.",
    {
      orgId: string,
      userId: string,
      role: { type: "string", enum: ["member", "owner"] },
    },
    ["orgId", "userId", "role"],
  ],
  [
    "members_remove",
    "Remove organization membership. Organization owner only.",
    { orgId: string, userId: string },
    ["orgId", "userId"],
  ],
  [
    "invitations_create",
    "Create a one-use organization invitation link valid for seven days. No email is sent.",
    {
      orgId: string,
      role: { type: "string", enum: ["member", "owner"] },
      teamId: string,
    },
    ["orgId"],
  ],
  [
    "invitations_list",
    "List pending organization invitations.",
    { orgId: string },
    ["orgId"],
  ],
  [
    "invitations_accept",
    "Accept an organization invitation using its token.",
    { token: string },
    ["token"],
  ],
  [
    "invitations_revoke",
    "Revoke an organization invitation.",
    { invitationId: string },
    ["invitationId"],
  ],
  ["teams_list", "List organization teams.", { orgId: string }, ["orgId"]],
  [
    "teams_create",
    "Create an organization team. Organization owner only.",
    { orgId: string, name: string },
    ["orgId", "name"],
  ],
  [
    "teams_update",
    "Rename a team. Organization owner only.",
    { teamId: string, name: string },
    ["teamId", "name"],
  ],
  [
    "teams_delete",
    "Delete an empty team. Organization owner only.",
    { teamId: string },
    ["teamId"],
  ],
  ["team_members_list", "List team members.", { teamId: string }, ["teamId"]],
  [
    "team_members_add",
    "Add an organization member to a team.",
    { teamId: string, userId: string },
    ["teamId", "userId"],
  ],
  [
    "team_members_remove",
    "Remove a team member.",
    { teamId: string, userId: string },
    ["teamId", "userId"],
  ],
  [
    "documents_list",
    "List readable documents. Super admins can list all users' documents.",
    {
      orgId: string,
      search: string,
      limit: { type: "integer", minimum: 1, maximum: 1000 },
      offset: { type: "integer", minimum: 0 },
    },
    [],
  ],
  [
    "documents_create",
    "Create a private Markdown document owned by you. Without orgId it goes to your personal workspace.",
    {
      orgId: string,
      title: string,
      source: string,
      teamId: string,
      access: { type: "string", enum: ["private", "view", "edit"] },
    },
    ["title", "source"],
  ],
  [
    "documents_get",
    "Read a document and its current version. Reading is the default.",
    { documentId: string },
    ["documentId"],
  ],
  [
    "documents_update",
    "Save a new immutable Markdown version. Requires edit access and the current baseVersion; stale saves are rejected.",
    {
      documentId: string,
      source: string,
      title: string,
      baseVersion: string,
      teamId: { type: ["string", "null"] },
      access: { type: "string", enum: ["private", "view", "edit"] },
    },
    ["documentId", "baseVersion"],
  ],
  [
    "documents_delete",
    "Permanently delete a document, its versions, and all links. File owner or super admin only.",
    { documentId: string },
    ["documentId"],
  ],
  [
    "documents_transfer",
    "Transfer document ownership to another username. Owner or super admin only.",
    { documentId: string, username: string },
    ["documentId", "username"],
  ],
  [
    "versions_list",
    "List version IDs, authors, dates, and SHA-256 checksums. Owner or super admin only.",
    { documentId: string },
    ["documentId"],
  ],
  [
    "versions_get",
    "Read an immutable version. Owner or super admin only.",
    { documentId: string, versionId: string },
    ["documentId", "versionId"],
  ],
  [
    "versions_restore",
    "Restore a prior version as a new save. Owner or super admin only.",
    { documentId: string, versionId: string, baseVersion: string },
    ["documentId", "versionId", "baseVersion"],
  ],
  [
    "shares_create",
    "Create a bearer link granting view (default) or edit access. Owners only. Pinned versions are view-only. The result's sensitive field lists any key, token, password, email address, public IP or named home directory in what the link exposes (secrets masked); when its level is \"secret\", tell the user before passing the link on.",
    {
      documentId: string,
      role,
      versionId: string,
      label: string,
      expiresAt: string,
    },
    ["documentId"],
  ],
  [
    "shares_list",
    "List link metadata without revealing secret tokens. Owners only.",
    { documentId: string },
    ["documentId"],
  ],
  [
    "shares_revoke",
    "Revoke a share link immediately. Owners only.",
    { documentId: string, shareId: string },
    ["documentId", "shareId"],
  ],
  [
    "permissions_list",
    "List named collaborators. Owners only.",
    { documentId: string },
    ["documentId"],
  ],
  [
    "permissions_set",
    "Grant or change a named user's view/edit access. Owners only.",
    { documentId: string, username: string, role },
    ["documentId", "username", "role"],
  ],
  [
    "permissions_remove",
    "Remove a named collaborator. Owners only.",
    { documentId: string, userId: string },
    ["documentId", "userId"],
  ],
  [
    "tokens_list",
    "List your personal API tokens (secrets are never returned).",
    {},
    [],
  ],
  [
    "tokens_create",
    "Create a personal API token with your account's permissions, valid for 90 days. Returned once; keep secret.",
    { label: string },
    [],
  ],
  [
    "tokens_revoke",
    "Revoke one of your personal API tokens.",
    { tokenId: string },
    ["tokenId"],
  ],
  ["admin_users", "List all users. Super administrator only.", {}, []],
  [
    "shared_get",
    "Read a Markdown document from a readm3 capability URL.",
    { url: string },
    ["url"],
  ],
  [
    "shared_update",
    "Save through an edit link. View links cannot write. Requires current baseVersion.",
    { url: string, source: string, baseVersion: string },
    ["url", "source", "baseVersion"],
  ],
];
/** table_query: the text from wherever it was pointed at, then src/csv.ts does the rest. */
async function tableQuery(args: Record<string, unknown>): Promise<unknown> {
  const given = ["source", "path", "url"].filter((key) => typeof args[key] === "string" && args[key] !== "");
  if (given.length !== 1) throw new Error("Give exactly one of source, path or url.");
  let source: string;
  let name: string | undefined;
  if (typeof args.source === "string" && args.source) source = args.source;
  else if (typeof args.path === "string" && args.path) {
    source = readFileSync(args.path, "utf8");
    name = args.path;
  } else {
    const url = String(args.url);
    if (/\/p\/[A-Za-z0-9_-]{43}/.test(url)) {
      const { token, config } = pasteLocation(url);
      const paste = await cloudRequest(`pastes/${token}`, "GET", undefined, config) as { source: string; title: string };
      source = paste.source;
      name = paste.title;
    } else {
      if (!/^https?:\/\//.test(url)) throw new Error("url must be http(s).");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
      source = await response.text();
      name = new URL(url).pathname;
    }
  }
  return queryTable(source, {
    name,
    filter: typeof args.filter === "string" ? args.filter : undefined,
    sort: typeof args.sort === "string" || typeof args.sort === "number" ? args.sort : undefined,
    descending: args.descending === true,
    limit: typeof args.limit === "number" ? args.limit : undefined,
    offset: typeof args.offset === "number" ? args.offset : undefined,
    stats: typeof args.stats === "string" || typeof args.stats === "number" ? args.stats : undefined,
  });
}

export async function runMcp() {
  const server = new Server(
    { name: "readm3", version: "0.6.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map(([name, description, properties, required]) => ({
      name,
      description,
      inputSchema: {
        type: "object" as const,
        properties,
        required,
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: /_(list|get|me|users|revisions|query)$/.test(name),
        destructiveHint: /_(delete|remove|revoke|transfer)$/.test(name),
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (!definitions.some(([operation]) => operation === name))
        throw new Error("Unknown tool.");
      let result: unknown;
      if (name === "table_query") result = await tableQuery(args);
      else if (name.startsWith("settings_")) {
        if (name === "settings_save" && (!Number.isSafeInteger(args.ifRevision) || Number(args.ifRevision) < 0 || !args.snapshot)) throw new Error("snapshot and a nonnegative ifRevision are required.");
        result = await cloudRequest(name === "settings_revisions" ? "settings/revisions" : "settings", name === "settings_save" ? "PUT" : "GET", name === "settings_save" ? { snapshot: args.snapshot, ifRevision: args.ifRevision } : undefined);
      } else if (name.startsWith("paste_")) {
        if (name === "paste_create")
          result = await cloudRequest("pastes", "POST", { source: args.source, title: args.title, expiresIn: args.expiresIn, language: args.language });
        else {
          const { token, config } = pasteLocation(String(args.url));
          result = await cloudRequest(`pastes/${token}`, name === "paste_delete" ? "DELETE" : "GET", undefined, config);
        }
      } else if (name.startsWith("shared_")) {
        const { token, config } = sharedLocation(String(args.url));
        result = await cloudRequest(
          `shared/${token}`,
          name === "shared_update" ? "PATCH" : "GET",
          name === "shared_update"
            ? { source: args.source, baseVersion: args.baseVersion }
            : undefined,
          config,
        );
      } else result = await cloudAction(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : "Request failed.",
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
