/**
 * Stored files on this device and on the account (src/blob-store.ts, server/blobs.ts).
 *
 * On the device a stored file is one Blob in IndexedDB under `blob:<id>`; browsers keep a
 * large Blob on disk, not in memory, so a 5 GB file is fine where a 5 GB string is not.
 * On the account it is encrypted chunks, uploaded and downloaded one at a time.
 */
import { ApiError, request } from "./cloud.ts";
import { readKey, writeKey } from "./workspace.ts";
import { CHUNK_BYTES, chunkCount, chunkPlainBytes, decryptChunk, encryptChunk, type BlobRef } from "../src/blob-store.ts";

export interface StorageAccount {
  usedBytes: number;
  freeBytes: number;
  maxFileBytes: number;
  microsPerGibMonth: number;
  balanceMicros: number;
  /** An admin's account: never charged. */
  exempt?: boolean;
  topups: boolean;
  blobs: { id: string; size: number; complete: boolean; createdAt: string }[];
}

const localKey = (id: string) => `blob:${id}`;
/**
 * Files the desktop app opened from disk: read from there each time, never copied into
 * browser storage. A reader lasts for the session; opening the folder again restores it.
 */
const onDisk = new Map<string, () => Promise<Blob>>();
export const fromDisk = (ref: Pick<BlobRef, "id">, read: () => Promise<Blob>) => { onDisk.set(ref.id, read); };
export async function local(ref: Pick<BlobRef, "id">): Promise<Blob | undefined> {
  const read = onDisk.get(ref.id);
  if (read) { try { return await read(); } catch { /* Moved or deleted on disk: a kept or synced copy may still exist. */ } }
  return readKey<Blob>(localKey(ref.id)).catch(() => undefined);
}
export const keep = (ref: Pick<BlobRef, "id">, blob: Blob) => writeKey(localKey(ref.id), blob);
export const forget = (ref: Pick<BlobRef, "id">) => { onDisk.delete(ref.id); return writeKey(localKey(ref.id), undefined).catch(() => undefined); };

export const account = () => request<StorageAccount>("blobs");
export const remove = (id: string) => request(`blobs/${id}`, "DELETE");

async function failure(response: Response): Promise<ApiError> {
  // Named on the account by another device that has not uploaded it (yet): say so, not "chunk".
  if (response.status === 404) return new ApiError("This file is not on your account yet. The device that has it uploads it on its next sync; open readm3 there.", 404);
  let message = `Storage request failed (${response.status})`;
  try { message = (await response.json()).error || message; } catch { /* Not JSON. */ }
  return new ApiError(message, response.status);
}

/** Encrypts and uploads every chunk, then marks the file complete; a failed upload restarts from chunk 0. */
export async function upload(ref: BlobRef, blob: Blob, onProgress?: (done: number) => void) {
  for (let n = 0; n < chunkCount(ref.size); n++) {
    const start = n * CHUNK_BYTES;
    const plain = new Uint8Array(await blob.slice(start, start + chunkPlainBytes(ref.size, n)).arrayBuffer());
    const sealed = await encryptChunk(ref, n, plain);
    const response = await fetch(`/api/v1/blobs/${ref.id}/${n}?size=${ref.size}`, {
      method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: sealed as BodyInit,
    });
    if (!response.ok) throw await failure(response);
    onProgress?.(Math.min(ref.size, start + plain.byteLength));
  }
  await request(`blobs/${ref.id}/complete`, "POST", {});
}

/** Downloads and decrypts a stored file, chunk by chunk, into one Blob. */
export async function download(ref: BlobRef, type = "", onProgress?: (done: number) => void): Promise<Blob> {
  const parts: Blob[] = [];
  let done = 0;
  for (let n = 0; n < chunkCount(ref.size); n++) {
    const response = await fetch(`/api/v1/blobs/${ref.id}/${n}`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw await failure(response);
    const plain = await decryptChunk(ref, n, new Uint8Array(await response.arrayBuffer()));
    parts.push(new Blob([plain as BlobPart]));
    done += plain.byteLength;
    onProgress?.(done);
  }
  return new Blob(parts, { type });
}

/** The file's bytes: from this device, or fetched from the account once and kept here. */
export async function bytes(ref: BlobRef, type = "", onProgress?: (done: number) => void): Promise<Blob> {
  const kept = await local(ref);
  if (kept) return type && kept.type !== type ? new Blob([kept], { type }) : kept;
  const fetched = await download(ref, type, onProgress);
  await keep(ref, fetched).catch(() => { /* Browser storage full: still shown, fetched again next time. */ });
  return fetched;
}
