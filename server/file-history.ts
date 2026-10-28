/**
 * Version history of each synced file, kept on the account so every device sees it and
 * any version can be restored. Like the workspace it is end-to-end encrypted: a version
 * is a sealed envelope (src/sync-crypto.ts) the server cannot open, filed under a tag
 * the device derives from the path with the sync key (`pathTag`), so the server never
 * learns a file's name either.
 *
 *   GET  /api/v1/file-history?tag=<tag>   the file's versions, newest first (no bodies)
 *   GET  /api/v1/file-history/<id>        one version's sealed envelope
 *   POST /api/v1/file-history             { versions: [{ tag, sealed, ifEmpty? }] }
 *
 * `ifEmpty` files a version only when the tag has none yet: a device sends the text a
 * file had before its first synced edit that way, so the history starts from there.
 * The newest KEEP_VERSIONS per file are kept, and an account holds at most MAX_BYTES.
 */
import { Store, HttpError, now } from "./store.ts";
import type { Accounts } from "./accounts.ts";
import { envelopeProblem } from "../src/sync-crypto.ts";

export const KEEP_VERSIONS = 50;
/** A sealed version: a 4 MB file compresses, and base64 adds a third. */
export const MAX_VERSION_BYTES = 6 * 1024 * 1024;
export const MAX_ACCOUNT_BYTES = 512 * 1024 * 1024;
const MAX_BATCH = 200;
const TAG = /^[0-9a-f]{64}$/;

export const FILE_HISTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS file_versions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag TEXT NOT NULL, sealed TEXT NOT NULL, size INTEGER NOT NULL, createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS file_versions_tag ON file_versions(userId, tag, createdAt);
`;

export interface VersionInput { tag: string; sealed: string; ifEmpty?: boolean }

export class FileHistory {
  constructor(private store: Store) { store.db.exec(FILE_HISTORY_SCHEMA); }

  list(userId: string, tag: string) {
    if (!TAG.test(tag)) throw new HttpError(400, "tag must be 64 hex characters.");
    return this.store.all<{ id: string; size: number; createdAt: string }>(
      "SELECT id,size,createdAt FROM file_versions WHERE userId=? AND tag=? ORDER BY createdAt DESC, rowid DESC LIMIT ?", userId, tag, KEEP_VERSIONS);
  }

  get(userId: string, id: string) {
    const row = this.store.get<{ id: string; sealed: string; createdAt: string }>("SELECT id,sealed,createdAt FROM file_versions WHERE userId=? AND id=?", userId, id);
    if (!row) throw new HttpError(404, "Version not found.");
    return row;
  }

  add(userId: string, versions: unknown): { saved: number } {
    if (!Array.isArray(versions) || versions.length > MAX_BATCH) throw new HttpError(400, `versions must be an array of up to ${MAX_BATCH}.`);
    for (const version of versions as VersionInput[]) {
      if (!version || typeof version !== "object" || !TAG.test(String(version.tag)) || typeof version.sealed !== "string")
        throw new HttpError(400, "Each version needs a tag and a sealed envelope.");
      if (version.sealed.length > MAX_VERSION_BYTES) throw new HttpError(413, "A version may be up to 6 MB sealed.");
      let envelope: unknown;
      try { envelope = JSON.parse(version.sealed); } catch { throw new HttpError(400, "sealed must be a JSON envelope."); }
      const problem = envelopeProblem(envelope);
      if (problem) throw new HttpError(400, problem.replace("sealed.json", "sealed"));
    }
    let saved = 0;
    this.store.db.transaction(() => {
      for (const { tag, sealed, ifEmpty } of versions as VersionInput[]) {
        if (ifEmpty && this.store.get("SELECT 1 FROM file_versions WHERE userId=? AND tag=? LIMIT 1", userId, tag)) continue;
        this.store.run("INSERT INTO file_versions VALUES (?,?,?,?,?,?)", crypto.randomUUID(), userId, tag, sealed, sealed.length, now());
        saved++;
        this.store.run(`DELETE FROM file_versions WHERE userId=? AND tag=? AND id NOT IN
          (SELECT id FROM file_versions WHERE userId=? AND tag=? ORDER BY createdAt DESC, rowid DESC LIMIT ?)`, userId, tag, userId, tag, KEEP_VERSIONS);
      }
      // Past the account's allowance the oldest versions of any file go first.
      let total = this.store.get<{ total: number }>("SELECT COALESCE(SUM(size),0) AS total FROM file_versions WHERE userId=?", userId)!.total;
      while (total > MAX_ACCOUNT_BYTES) {
        const oldest = this.store.get<{ id: string; size: number }>("SELECT id,size FROM file_versions WHERE userId=? ORDER BY createdAt, rowid LIMIT 1", userId);
        if (!oldest) break;
        this.store.run("DELETE FROM file_versions WHERE id=?", oldest.id);
        total -= oldest.size;
      }
    }).immediate();
    return { saved };
  }
}

export function createFileHistoryApi(history: FileHistory, accounts: Accounts) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/file-history(?:\/([\w-]{1,64}))?$/);
    if (!match) return null;
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    try {
      const origin = request.headers.get("origin");
      if ((origin && origin !== accounts.origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Cross-origin API requests are not allowed.");
      const authorization = request.headers.get("authorization");
      const token = authorization ? /^Bearer (\S+)$/i.exec(authorization)?.[1] : accounts.token(request);
      const user = token ? accounts.authenticate(token) : null;
      if (!user) throw new HttpError(401, "Sign in to keep file history on your account.");
      if (!authorization && request.method !== "GET" && !origin) throw new HttpError(403, "Browser writes require a same-origin Origin header.");
      const [, id] = match;
      if (request.method === "GET") return reply(id ? history.get(user.id, id) : { versions: history.list(user.id, url.searchParams.get("tag") ?? "") });
      if (id || request.method !== "POST") throw new HttpError(405, "Method not allowed.");
      if (Number(request.headers.get("content-length")) > 40 * 1024 * 1024) throw new HttpError(413, "Request too large.");
      let body: { versions?: unknown };
      try { body = await request.json() as { versions?: unknown }; } catch { throw new HttpError(400, "Invalid JSON object."); }
      return reply(history.add(user.id, body?.versions));
    } catch (error) {
      if (error instanceof HttpError) return reply({ ok: false, error: error.message }, error.status);
      console.error("readm3 file history:", error instanceof Error ? error.message : "Unknown error");
      return reply({ ok: false, error: "Unable to reach file history right now." }, 500);
    }
  };
}
