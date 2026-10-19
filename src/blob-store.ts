/**
 * Large files, stored apart from the synced workspace.
 *
 * A signed-in account may keep files of up to 5 GB, and any number of them. A file that
 * large cannot live in the workspace JSON (a string, synced as one request), so it is
 * a `blob` document: the workspace keeps a reference, and the bytes live on their own,
 * in IndexedDB on the device and in fixed-size chunks on readm3.com.
 *
 * Every blob has its own random AES-256 key. The key travels only inside the reference,
 * which travels only inside the sealed (end-to-end encrypted) workspace, so the server
 * stores chunks it cannot read and cannot link to a file name. Chunk n is encrypted
 * with AES-256-GCM under an IV that is n itself: unique, since no key is reused across
 * blobs, and a chunk moved to another position fails authentication.
 *
 * Small text files that do not fit the snapshot are stored the same way ("spilled") and
 * carry the document's digest, so the merge sees the same document either way.
 *
 * Browser-safe: Web Crypto only. Shared by the page, the server and the tests.
 */
export const GiB = 1024 ** 3;
/** The largest single file an account may keep. */
export const MAX_BLOB_BYTES = 5 * GiB;
/** Files in one signed-in workspace (signed out, the workspace keeps 1,000). */
export const MAX_ACCOUNT_FILES = 5000;
/** Storage every signed-in account gets free; more is pay as you go from the prepaid balance. */
export const FREE_STORAGE_BYTES = 5 * GiB;
/** Pay as you go: micro-dollars per GiB stored per month, over the free allowance. */
export const STORAGE_MICROS_PER_GIB_MONTH = 50_000;
/** Plaintext bytes per chunk; each stored chunk is 16 bytes longer (the GCM tag). */
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const TAG_BYTES = 16;
/** Text larger than this opens read-only, as a preview; smaller text is edited in the workspace. */
export const INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** Inline text kept inside one synced snapshot; the rest of the small files spill to blobs. */
export const SNAPSHOT_INLINE_BYTES = 16 * 1024 * 1024;

export interface BlobRef {
  /** 22 url-safe characters: random, never derived from the content. */
  id: string;
  /** Plaintext bytes. */
  size: number;
  /** Base64 of the 32-byte AES key. */
  key: string;
  /** Set on a spilled text file: the document digest, so it compares equal to the inline copy. */
  digest?: string;
}

const ID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9+/]{43}=$/;
export const isBlobId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

export function blobRefProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "A stored file reference must be an object.";
  const ref = value as Record<string, unknown>;
  if (Object.keys(ref).some((key) => !["id", "size", "key", "digest"].includes(key))) return "A stored file reference has unknown fields.";
  if (!isBlobId(ref.id)) return "A stored file has an invalid id.";
  if (!Number.isSafeInteger(ref.size) || (ref.size as number) < 0 || (ref.size as number) > MAX_BLOB_BYTES) return "A stored file is larger than 5 GB.";
  if (typeof ref.key !== "string" || !KEY.test(ref.key)) return "A stored file has an invalid key.";
  if (ref.digest !== undefined && (typeof ref.digest !== "string" || !/^[a-z0-9]{1,16}:[a-z0-9]{1,16}$/.test(ref.digest))) return "A stored file has an invalid digest.";
  return null;
}

const b64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function newBlobRef(size: number, digest?: string): BlobRef {
  const id = b64(crypto.getRandomValues(new Uint8Array(16))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return { id, size, key: b64(crypto.getRandomValues(new Uint8Array(32))), ...(digest ? { digest } : {}) };
}

export const chunkCount = (size: number): number => Math.max(1, Math.ceil(size / CHUNK_BYTES));
/** Plaintext bytes in chunk n of a blob of `size` bytes. */
export const chunkPlainBytes = (size: number, n: number): number => Math.max(0, Math.min(CHUNK_BYTES, size - n * CHUNK_BYTES));
/** What the server stores for chunk n: the ciphertext and its tag. */
export const chunkStoredBytes = (size: number, n: number): number => chunkPlainBytes(size, n) + TAG_BYTES;
/** Everything the server holds for a blob, which is what the account's storage counts. */
export const storedBytes = (size: number): number => size + chunkCount(size) * TAG_BYTES;

const iv = (n: number): Uint8Array => { const bytes = new Uint8Array(12); new DataView(bytes.buffer).setUint32(8, n); return bytes; };
const keys = new Map<string, Promise<CryptoKey>>();
const cryptoKey = (ref: BlobRef) => {
  let key = keys.get(ref.key);
  if (!key) { key = crypto.subtle.importKey("raw", unb64(ref.key) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]); keys.set(ref.key, key); }
  return key;
};

export async function encryptChunk(ref: BlobRef, n: number, plain: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv(n) as BufferSource }, await cryptoKey(ref), plain as BufferSource));
}

export async function decryptChunk(ref: BlobRef, n: number, stored: Uint8Array): Promise<Uint8Array> {
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv(n) as BufferSource }, await cryptoKey(ref), stored as BufferSource)); }
  catch { throw new Error("A stored file chunk failed to decrypt; it was damaged or replaced."); }
}

export const formatStorage = (bytes: number): string =>
  bytes >= GiB ? `${(bytes / GiB).toFixed(bytes >= 10 * GiB ? 0 : 1)} GB` : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
