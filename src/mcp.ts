import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { cloudAction, cloudRequest, pasteLocation, sharedLocation } from "./cloud-client.ts";
const string = { type: "string" };
const role = { type: "string", enum: ["view", "edit"] };
const definitions: [string, string, Record<string, unknown>, string[]][] = [
  ["paste_create", "Create an anonymous paste: a Markdown document behind a secret link, no account needed. Expires after 7 days by default (1h, 1d, 7d or 30d), 256 KB at most. Returns the URL; keep it, the server cannot show it again.", { source: string, title: string, expiresIn: { type: "string", enum: ["1h", "1d", "7d", "30d"] } }, ["source"]],
  ["paste_get", "Read an anonymous paste by its URL.", { url: string }, ["url"]],
  ["paste_delete", "Delete an anonymous paste by its URL. The link stops working for everyone.", { url: string }, ["url"]],
  ["settings_get", "Read the verified account's latest settings and Markdown workspace snapshot, including its revision.", {}, []],
  ["settings_save", "Save settings.json and workspace.json. Use the revision from settings_get, or 0 for a first save. Stale saves are rejected.", {
    snapshot: { type: "object", properties: { version: { type: "integer", const: 1 }, files: { type: "object", description: "Only settings.json and workspace.json, each containing a JSON string in its content property." } }, required: ["version", "files"] },
    ifRevision: { type: "integer", minimum: 0 },
  }, ["snapshot", "ifRevision"]],
  ["settings_revisions", "List the verified account's last ten sync revisions.", {}, []],
  ["account_me", "Show the authenticated readm3 user.", {}, []],
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
    "Create a private Markdown document owned by you.",
    {
      orgId: string,
      title: string,
      source: string,
      teamId: string,
      access: { type: "string", enum: ["private", "view", "edit"] },
    },
    ["orgId", "title", "source"],
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
    "Create a bearer link granting view (default) or edit access. Owners only. Pinned versions are view-only.",
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
        readOnlyHint: /_(list|get|me|users|revisions)$/.test(name),
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
      if (name.startsWith("settings_")) {
        if (name === "settings_save" && (!Number.isSafeInteger(args.ifRevision) || Number(args.ifRevision) < 0 || !args.snapshot)) throw new Error("snapshot and a nonnegative ifRevision are required.");
        result = await cloudRequest(name === "settings_revisions" ? "settings/revisions" : "settings", name === "settings_save" ? "PUT" : "GET", name === "settings_save" ? { snapshot: args.snapshot, ifRevision: args.ifRevision } : undefined);
      } else if (name.startsWith("paste_")) {
        if (name === "paste_create")
          result = await cloudRequest("pastes", "POST", { source: args.source, title: args.title, expiresIn: args.expiresIn });
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
