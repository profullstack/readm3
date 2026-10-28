/**
 * End-to-end encryption for synced workspaces. The server stores one sealed blob per
 * revision and can read nothing in it: not the documents, their names, or the settings.
 *
 *   files JSON → gzip → AES-256-GCM (key from the sync passphrase) → base64 envelope
 *
 * The key is PBKDF2-SHA256 (600,000 iterations, a random 16-byte salt per account) over
 * the person's sync passphrase, which never leaves the device. The salt and iteration
 * count travel in each envelope so any device can derive the same key; a wrong
 * passphrase fails GCM authentication rather than producing garbage. Web Crypto and
 * CompressionStream only, so the same code runs in browsers, the desktop app, Node and Bun.
 */
export const SEALED_FILE = "sealed.json";
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;

export interface Kdf { name: "PBKDF2-SHA256"; iterations: number; salt: string }
export interface Envelope { v: 1; alg: "AES-256-GCM"; zip: "gzip"; kdf: Kdf; iv: string; data: string }
export interface SyncKey { key: CryptoKey; kdf: Kdf }

export class WrongPassphrase extends Error {
  constructor() { super("That passphrase does not open this account's synced files."); }
}

const b64 = (bytes: Uint8Array): string => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

/** A new account key: fresh salt. */
export const newKdf = (): Kdf => ({ name: "PBKDF2-SHA256", iterations: KDF_ITERATIONS, salt: b64(crypto.getRandomValues(new Uint8Array(16))) });

export async function deriveKey(passphrase: string, kdf: Kdf): Promise<SyncKey> {
  if (kdf.name !== "PBKDF2-SHA256" || !Number.isSafeInteger(kdf.iterations) || kdf.iterations < 100_000 || kdf.iterations > 10_000_000)
    throw new Error("Unsupported key derivation in the synced files.");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: unb64(kdf.salt) as BufferSource, iterations: kdf.iterations },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
  return { key, kdf };
}

export async function seal(value: unknown, { key, kdf }: SyncKey): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("gzip"));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, packed as BufferSource));
  return { v: 1, alg: "AES-256-GCM", zip: "gzip", kdf, iv: b64(iv), data: b64(sealed) };
}

export async function open<T = unknown>(envelope: Envelope, { key }: SyncKey): Promise<T> {
  let packed: Uint8Array;
  try { packed = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv) as BufferSource }, key, unb64(envelope.data) as BufferSource)); }
  catch { throw new WrongPassphrase(); }
  return JSON.parse(new TextDecoder().decode(await pipe(packed, new DecompressionStream("gzip")))) as T;
}

/** The envelope's shape, checked on the server, which cannot check anything inside it. */
export function envelopeProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "sealed.json must be an object";
  const e = value as Record<string, unknown>;
  if (Object.keys(e).some((key) => !["v", "alg", "zip", "kdf", "iv", "data"].includes(key))) return "sealed.json has unknown fields";
  if (e.v !== 1 || e.alg !== "AES-256-GCM" || e.zip !== "gzip") return "unsupported sealed.json format";
  const kdf = e.kdf as Record<string, unknown> | undefined;
  if (!kdf || kdf.name !== "PBKDF2-SHA256" || !Number.isSafeInteger(kdf.iterations) || typeof kdf.salt !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(kdf.salt)) return "invalid key derivation";
  if (typeof e.iv !== "string" || !/^[A-Za-z0-9+/]{16}$/.test(e.iv)) return "invalid iv";
  if (typeof e.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.data)) return "invalid sealed data";
  return null;
}

/**
 * A file's name as the server may see it: 64 hex characters that only someone with the
 * sync key can produce from the path. AES-GCM over the path's SHA-256, with an IV taken
 * from that hash, so the same path always gives the same tag and an IV repeats only
 * for the same path (the one case where the output is meant to repeat).
 */
export async function pathTag(path: string, { key }: SyncKey): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`readm3 path\0${path}`)));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: digest.slice(0, 12) as BufferSource }, key, digest as BufferSource));
  const tag = new Uint8Array(await crypto.subtle.digest("SHA-256", sealed as BufferSource));
  return [...tag].map((n) => n.toString(16).padStart(2, "0")).join("");
}
