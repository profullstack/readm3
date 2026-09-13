import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { collectSnapshot, createClient, digestFiles, load, loadMarker, save, status, type SyncContext } from "@profullstack/synconfig";
import { configDir, credentials } from "./account.ts";
import { SYNC_FILES, SYNC_POLICY, validateSyncFiles } from "./sync-schema.ts";

function checkLocalFiles(ctx: SyncContext) {
  for (const name of [...SYNC_FILES, ctx.markerName || "sync.json"]) {
    const path = join(ctx.rootDir, name);
    try { if (!lstatSync(path).isFile()) throw new Error(`Sync needs a regular file: ${name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function syncContext(rootDir = configDir()): Promise<SyncContext> {
  const account = await credentials(rootDir);
  const identity = createHash("sha256").update(`${account.api}\0${account.user.id}`).digest("hex");
  const client = createClient({ baseUrl: account.api, path: "/settings", token: account.token, fetchImpl: ((input, init) => fetch(input, { ...init, redirect: "error" })) as typeof fetch });
  return { rootDir, policy: SYNC_POLICY, api: `${account.api}#${account.user.id}`, markerName: `sync-${identity}.json`, host: hostname(), app: "readm3 0.5.0", client: {
    ...client,
    async get() {
      const latest = await client.get();
      if (latest) {
        validateSyncFiles(latest.snapshot.files);
        if (digestFiles(latest.snapshot.files) !== latest.digest) throw new Error("Snapshot digest does not match its contents.");
      }
      return latest;
    },
    put: (snapshot, revision) => client.put(snapshot, revision),
  } };
}

export async function saveSettings(ctx: SyncContext, options: { force?: boolean } = {}) {
  checkLocalFiles(ctx);
  const { snapshot, skipped } = collectSnapshot(ctx.rootDir, ctx.policy, { host: ctx.host, app: ctx.app });
  if (skipped.length) throw new Error(`Cannot save an incomplete snapshot: ${skipped.map((entry) => entry.path).join(", ")}`);
  validateSyncFiles(snapshot.files);
  // synconfig uses null for a missing marker. readm3 requires an explicit force
  // to replace an account copy the current device has never loaded.
  const guarded = { ...ctx, client: { ...ctx.client, put: (body: Parameters<typeof ctx.client.put>[0], revision: number | null) => ctx.client.put(body, options.force ? null : revision ?? 0) } };
  return save(guarded, options);
}

export async function loadSettings(ctx: SyncContext, options: { force?: boolean; dryRun?: boolean } = {}) {
  checkLocalFiles(ctx);
  const latest = await ctx.client.get();
  ctx = { ...ctx, client: { ...ctx.client, get: async () => latest } };
  const plan = await load(ctx, { dryRun: true });
  if (options.dryRun) return plan;
  // A first load also needs protection: the package has no baseline to detect
  // local edits yet. Force still creates the package's numbered backups.
  if (!loadMarker(ctx.rootDir, ctx.markerName) && !options.force) {
    const existing = plan.plan.filter((item) => item.status === "changed");
    if (existing.length) return { ...plan, status: "local_changes" as const, drifted: existing.map((item) => item.path) };
  }
  return load(ctx, options);
}

export async function syncStatus(ctx: SyncContext) {
  // Do not let the package's status helper hide an authentication/network error.
  const latest = await ctx.client.get();
  return status({ ...ctx, client: { ...ctx.client, get: async () => latest } });
}

export function localSettings(root = configDir()) {
  const path = join(root, "settings.json");
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf8");
  validateSyncFiles({ "settings.json": { content } });
  return JSON.parse(content) as { theme?: string; flavor?: import("./flavors.ts").Flavor };
}
