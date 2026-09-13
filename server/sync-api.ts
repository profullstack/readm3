import { handleGet, handlePut, handleRevisions, snapshotProblem } from "@profullstack/synconfig/server";
import { Store, HttpError } from "./store.ts";
import { Accounts } from "./accounts.ts";
import { snapshotStore } from "./sync.ts";
import { SYNC_LIMITS, validateSyncFiles } from "../src/sync-schema.ts";

export function createSyncApi(store: Store, accounts: Accounts) {
  const snapshots = snapshotStore(store);
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!["/api/v1/settings", "/api/v1/settings/revisions", "/api/v1/synconfig", "/api/v1/synconfig/revisions"].includes(url.pathname)) return null;
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    try {
      const origin = request.headers.get("origin");
      if ((origin && origin !== accounts.origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Cross-origin API requests are not allowed.");
      const authorization = request.headers.get("authorization");
      const token = authorization ? /^Bearer (\S+)$/i.exec(authorization)?.[1] : accounts.token(request);
      const user = token ? accounts.authenticate(token) : null;
      if (!user) throw new HttpError(401, "Sign in or provide a personal API token.");
      const expectedAccount = url.searchParams.get("accountId");
      if (expectedAccount && expectedAccount !== user.id) throw new HttpError(409, "Your account changed. Reopen Sync.");
      if (!authorization && request.method !== "GET" && !origin) throw new HttpError(403, "Browser writes require a same-origin Origin header.");
      if (request.method === "GET") {
        const result = url.pathname.endsWith("/revisions") ? await handleRevisions(snapshots, user.id) : await handleGet(snapshots, user.id);
        return reply({ ...result.body, userId: user.id }, result.status);
      }
      if (request.method !== "PUT" || url.pathname.endsWith("/revisions")) throw new HttpError(405, "Method not allowed.");
      if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "Use application/json.");
      const max = 40 * 1024 * 1024;
      if (Number(request.headers.get("content-length")) > max) throw new HttpError(413, "Request too large.");
      const reader = request.body?.getReader();
      if (!reader) throw new HttpError(400, "JSON body required.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > max) { await reader.cancel(); throw new HttpError(413, "Request too large."); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
      } catch { throw new HttpError(400, "Invalid JSON object."); }
      if (body.accountId !== undefined && body.accountId !== user.id) throw new HttpError(409, "Your account changed. Reopen Sync.");
      if (!(body.ifRevision === null || (Number.isSafeInteger(body.ifRevision) && Number(body.ifRevision) >= 0))) throw new HttpError(428, "ifRevision is required: 0 for a first save, the last loaded revision, or null for an explicit forced save.");
      const problem = snapshotProblem(body.snapshot, SYNC_LIMITS);
      if (problem) throw new HttpError(400, problem);
      try { validateSyncFiles((body.snapshot as { files: Record<string, { content: string }> }).files); }
      catch (error) { throw new HttpError(400, (error as Error).message); }
      const strictStore = { ...snapshots, insert: (userId: string, entry: Parameters<typeof snapshots.insert>[1]) => snapshots.insert(userId, entry, body.ifRevision as number | null) };
      const result = await handlePut(strictStore, user.id, body, SYNC_LIMITS);
      return reply({ ...result.body, userId: user.id }, result.status);
    } catch (error) {
      if (error instanceof HttpError) return reply({ ok: false, error: error.message }, error.status);
      console.error("readm3 sync:", error instanceof Error ? error.message : "Unknown error");
      return reply({ ok: false, error: "Unable to sync right now." }, 500);
    }
  };
}
