/**
 * Stored files (src/blob-store.ts): the encrypted chunks of files too large for the
 * synced workspace, kept on disk under `<dir>/<userId>/<blobId>/<n>`, with one row per
 * blob so an account's storage is a SUM, not a directory walk.
 *
 *   GET    /api/v1/blobs                 usage, the free allowance, the price, every blob
 *   PUT    /api/v1/blobs/<id>/<n>?size=  one encrypted chunk (application/octet-stream)
 *   POST   /api/v1/blobs/<id>/complete   every chunk is there: the blob may be referenced
 *   GET    /api/v1/blobs/<id>/<n>        one encrypted chunk back
 *   DELETE /api/v1/blobs/<id>            gone, and no longer counted
 *
 * The free tier needs an account and nothing else: up to 5 GB per file, any number of
 * files, 5 GB stored. Past that it is pay as you go: the prepaid balance (CoinPay
 * top-ups, server/payments.ts) is charged every hour for what is stored over the
 * allowance, and a new chunk that would go over it needs a positive balance. Nothing
 * already stored is deleted when the balance runs out; it is still there to download.
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, HttpError, now } from "./store.ts";
import type { Accounts } from "./accounts.ts";
import type { Billing } from "./billing.ts";
import {
  chunkCount, chunkStoredBytes, formatStorage, FREE_STORAGE_BYTES, GiB, isBlobId, MAX_BLOB_BYTES, STORAGE_MICROS_PER_GIB_MONTH,
} from "../src/blob-store.ts";

export const BLOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS blobs (
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL,
    stored INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL, PRIMARY KEY(userId, id)
  );
  CREATE TABLE IF NOT EXISTS blob_chunks (
    userId TEXT NOT NULL, blobId TEXT NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY(userId, blobId, n),
    FOREIGN KEY(userId, blobId) REFERENCES blobs(userId, id) ON DELETE CASCADE
  );
`;
const HOURS_PER_MONTH = 730;
/** An upload left unfinished this long is abandoned; its chunks stop counting. */
const ABANDONED_MS = 2 * 24 * 3600 * 1000;

export interface BlobOptions {
  dir: string;
  freeBytes?: number;
  microsPerGibMonth?: number;
  /** Whether top-ups are open, so an over-quota refusal can say how to pay. */
  topups?: () => boolean;
}

type BlobRow = { id: string; size: number; chunks: number; stored: number; complete: number; createdAt: string };

export class Blobs {
  readonly dir: string;
  readonly freeBytes: number;
  readonly microsPerGibMonth: number;
  private topups: () => boolean;
  constructor(private store: Store, private billing: Billing, options: BlobOptions) {
    store.db.exec(BLOBS_SCHEMA);
    this.dir = options.dir;
    this.freeBytes = options.freeBytes ?? FREE_STORAGE_BYTES;
    this.microsPerGibMonth = options.microsPerGibMonth ?? STORAGE_MICROS_PER_GIB_MONTH;
    this.topups = options.topups ?? (() => false);
    mkdirSync(this.dir, { recursive: true });
  }

  used(userId: string): number {
    return this.store.get<{ total: number | null }>("SELECT SUM(stored) AS total FROM blobs WHERE userId=?", userId)?.total ?? 0;
  }

  account(userId: string) {
    return {
      usedBytes: this.used(userId),
      freeBytes: this.freeBytes,
      maxFileBytes: MAX_BLOB_BYTES,
      microsPerGibMonth: this.microsPerGibMonth,
      balanceMicros: this.billing.balance(userId),
      exempt: this.billing.exempt(userId),
      topups: this.topups(),
      blobs: this.store.all<BlobRow>("SELECT id,size,chunks,stored,complete,createdAt FROM blobs WHERE userId=? ORDER BY createdAt", userId)
        .map((row) => ({ ...row, complete: !!row.complete })),
    };
  }

  private path(userId: string, blobId: string, n?: number) {
    return n === undefined ? join(this.dir, userId, blobId) : join(this.dir, userId, blobId, String(n));
  }

  /** Stores chunk n of a blob, creating the blob on its first chunk. */
  putChunk(userId: string, blobId: string, n: number, size: number, body: Uint8Array) {
    if (!isBlobId(blobId)) throw new HttpError(400, "Invalid stored file id.");
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, "size is the file's length in bytes.");
    if (size > MAX_BLOB_BYTES) throw new HttpError(413, `A file may be up to ${formatStorage(MAX_BLOB_BYTES)}.`);
    const chunks = chunkCount(size);
    if (!Number.isSafeInteger(n) || n < 0 || n >= chunks) throw new HttpError(400, "That chunk is outside the file.");
    if (body.byteLength !== chunkStoredBytes(size, n)) throw new HttpError(400, `Chunk ${n} must be ${chunkStoredBytes(size, n)} bytes.`);
    const blob = this.store.get<BlobRow>("SELECT id,size,chunks,stored,complete,createdAt FROM blobs WHERE userId=? AND id=?", userId, blobId);
    if (blob && (blob.size !== size)) throw new HttpError(409, "That stored file has a different size.");
    if (blob?.complete) throw new HttpError(409, "That stored file is complete; it cannot change.");
    const had = this.store.get<{ bytes: number }>("SELECT bytes FROM blob_chunks WHERE userId=? AND blobId=? AND n=?", userId, blobId, n);
    const used = this.used(userId);
    const after = used + body.byteLength - (had?.bytes ?? 0);
    if (after > this.freeBytes && after > used && !this.billing.exempt(userId) && this.billing.balance(userId) <= 0) {
      throw new HttpError(402, `Your free ${formatStorage(this.freeBytes)} of storage is used. ${this.topups()
        ? `Add funds to store more: pay as you go, $${(this.microsPerGibMonth / 1e6).toFixed(2)} per GB a month over ${formatStorage(this.freeBytes)}.`
        : "Paid storage is not open yet; delete files you no longer need."}`, { usedBytes: used, freeBytes: this.freeBytes });
    }
    mkdirSync(this.path(userId, blobId), { recursive: true });
    const file = this.path(userId, blobId, n);
    writeFileSync(`${file}.part`, body);
    renameSync(`${file}.part`, file);
    this.store.db.transaction(() => {
      if (!blob) this.store.run("INSERT OR IGNORE INTO blobs (userId,id,size,chunks,stored,complete,createdAt) VALUES (?,?,?,?,0,0,?)", userId, blobId, size, chunks, now());
      this.store.run("INSERT OR REPLACE INTO blob_chunks (userId,blobId,n,bytes) VALUES (?,?,?,?)", userId, blobId, n, body.byteLength);
      this.store.run("UPDATE blobs SET stored=(SELECT COALESCE(SUM(bytes),0) FROM blob_chunks WHERE userId=?1 AND blobId=?2) WHERE userId=?1 AND id=?2", userId, blobId);
    }).immediate();
    return { usedBytes: this.used(userId) };
  }

  complete(userId: string, blobId: string) {
    const blob = this.store.get<BlobRow>("SELECT id,size,chunks,stored,complete,createdAt FROM blobs WHERE userId=? AND id=?", userId, blobId);
    if (!blob) throw new HttpError(404, "No such stored file.");
    const have = this.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM blob_chunks WHERE userId=? AND blobId=?", userId, blobId)!.count;
    if (have !== blob.chunks) throw new HttpError(409, `${blob.chunks - have} chunk(s) are still missing.`);
    this.store.run("UPDATE blobs SET complete=1 WHERE userId=? AND id=?", userId, blobId);
    return { id: blobId, size: blob.size, complete: true };
  }

  chunk(userId: string, blobId: string, n: number): string {
    if (!isBlobId(blobId)) throw new HttpError(400, "Invalid stored file id.");
    const row = this.store.get<{ bytes: number }>("SELECT bytes FROM blob_chunks WHERE userId=? AND blobId=? AND n=?", userId, blobId, n);
    const file = this.path(userId, blobId, n);
    try { if (row && statSync(file).size === row.bytes) return file; } catch { /* Missing on disk: not found. */ }
    throw new HttpError(404, "That stored file chunk is not here.");
  }

  remove(userId: string, blobId: string) {
    if (!isBlobId(blobId)) throw new HttpError(400, "Invalid stored file id.");
    this.store.run("DELETE FROM blob_chunks WHERE userId=? AND blobId=?", userId, blobId);
    this.store.run("DELETE FROM blobs WHERE userId=? AND id=?", userId, blobId);
    rmSync(this.path(userId, blobId), { recursive: true, force: true });
    return { usedBytes: this.used(userId) };
  }

  /**
   * Once an hour: charge each account for the hour's storage over the allowance, once
   * per hour (the ledger reference is unique), and drop uploads abandoned half way.
   */
  tick(at = new Date()) {
    const cutoff = new Date(at.getTime() - ABANDONED_MS).toISOString();
    for (const row of this.store.all<{ userId: string; id: string }>("SELECT userId,id FROM blobs WHERE complete=0 AND createdAt<?", cutoff)) this.remove(row.userId, row.id);
    const hour = at.toISOString().slice(0, 13);
    let charged = 0;
    for (const { userId, total } of this.store.all<{ userId: string; total: number }>("SELECT userId, SUM(stored) AS total FROM blobs GROUP BY userId HAVING total > ?", this.freeBytes)) {
      const micros = Math.ceil((total - this.freeBytes) / GiB * this.microsPerGibMonth / HOURS_PER_MONTH);
      if (micros > 0 && !this.billing.exempt(userId) && this.billing.debit(userId, micros, `storage:${userId}:${hour}`, JSON.stringify({ storedBytes: total, freeBytes: this.freeBytes, hour }))) charged++;
    }
    return { charged };
  }
}

/** The HTTP surface, signed in by session cookie (same origin) or a personal/OAuth bearer token. */
export function createBlobApi(blobs: Blobs, accounts: Accounts) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/v1\/blobs(?:\/([^/]+)(?:\/([^/]+))?)?$/);
    if (!match) return null;
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    try {
      const origin = request.headers.get("origin");
      if ((origin && origin !== accounts.origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Cross-origin API requests are not allowed.");
      const authorization = request.headers.get("authorization");
      const token = authorization ? /^Bearer (\S+)$/i.exec(authorization)?.[1] : accounts.token(request);
      const user = token ? accounts.authenticate(token) : null;
      if (!user) throw new HttpError(401, "Sign in to store files. The free tier only needs an account.");
      if (!authorization && request.method !== "GET" && !origin) throw new HttpError(403, "Browser writes require a same-origin Origin header.");
      const [, blobId, part] = match;
      if (!blobId) {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed.");
        return reply(blobs.account(user.id));
      }
      if (!part) {
        if (request.method !== "DELETE") throw new HttpError(405, "Method not allowed.");
        return reply(blobs.remove(user.id, blobId));
      }
      if (part === "complete") {
        if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
        return reply(blobs.complete(user.id, blobId));
      }
      if (!/^\d{1,6}$/.test(part)) throw new HttpError(404, "Not found.");
      const n = Number(part);
      if (request.method === "GET") {
        return new Response(Bun.file(blobs.chunk(user.id, blobId, n)), { headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
      }
      if (request.method !== "PUT") throw new HttpError(405, "Method not allowed.");
      const size = Number(url.searchParams.get("size"));
      if (size > MAX_BLOB_BYTES) throw new HttpError(413, `A file may be up to ${formatStorage(MAX_BLOB_BYTES)}.`);
      const declared = Number(request.headers.get("content-length"));
      if (declared && declared !== chunkStoredBytes(size, n)) throw new HttpError(400, `Chunk ${n} must be ${chunkStoredBytes(size, n)} bytes.`);
      const body = new Uint8Array(await request.arrayBuffer());
      return reply(blobs.putChunk(user.id, blobId, n, size, body));
    } catch (error) {
      if (error instanceof HttpError) return reply({ ok: false, error: error.message, ...error.details }, error.status);
      console.error("readm3 blobs:", error instanceof Error ? error.message : "Unknown error");
      return reply({ ok: false, error: "Unable to store files right now." }, 500);
    }
  };
}
