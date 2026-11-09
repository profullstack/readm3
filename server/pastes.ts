/**
 * Anonymous pastes: a file behind a secret link, no account needed.
 *
 * A paste is not a document. It has no owner, no organization, no versions and no
 * permissions; the 43-character token in its URL is the whole capability, and only
 * its hash is stored, so a paste cannot be listed or recovered once the link is lost.
 * Every paste expires, seven days by default and thirty at most, and expired rows are
 * purged the next time one is created. Whoever holds the link can read or delete it.
 *
 * A paste can be any text. Its language is decided once, here, from the file name
 * when one with a known extension is given and from the content otherwise, and stored
 * with the paste so the page, the CLI and the raw download all agree on what it is.
 *
 * A paste sent as the file itself (an upload or bare bytes) can also be any file up to
 * 2 GiB: an MP3, a video, an archive, a log too big for the database. Those are kept on
 * disk beside the database under the paste's id, with an empty `source` and `file=1`,
 * and read back through the raw link. All of them together are held to a storage budget.
 */
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { binaryType, detectLanguage, extensionOf, languageOf, looksBinary, MARKDOWN } from "../src/code.ts";
import { scanSensitive, type SensitiveReport } from "../src/sensitive.ts";

/** The language stored for a PDF, image or other binary paste, whose source is not text. */
export const BINARY = "binary";
import { HttpError, Store, checksum, id, now, secret, text } from "./store.ts";

/** The most a paste kept as text in the database may be; anything larger is a file on disk. */
export const PASTE_MAX_BYTES = 256 * 1024;
/** The most a paste sent as the file itself may be: 2 GiB. */
export const PASTE_FILE_MAX_BYTES = 2 * 1024 ** 3;
/** What every file paste together may take on disk before new ones are refused. */
export const PASTE_STORAGE_BYTES = 10 * 1024 ** 3;
export const PASTE_EXPIRIES: Record<string, number> = {
  "1h": 3600,
  "1d": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};
export const PASTE_DEFAULT_EXPIRY = "7d";

/** Where file pastes live, and how much they may take. */
export type PasteFiles = { dir: string; maxBytes: number; storageBytes: number };

/** Files that are neither text nor a PDF or image, served as their own type. */
const FILE_TYPES: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", ogv: "video/ogg",
  zip: "application/zip", gz: "application/gzip", tgz: "application/gzip", tar: "application/x-tar",
  "7z": "application/x-7z-compressed", xz: "application/x-xz", bz2: "application/x-bzip2", zst: "application/zstd",
  epub: "application/epub+zip", wasm: "application/wasm", iso: "application/x-iso9660-image",
};
const OCTET = "application/octet-stream";

/** Whether a file name says the file is binary: a PDF, an image, audio, video or an archive. */
export function binaryName(name: string | undefined): boolean {
  return !!name && (!!binaryType(name) || extensionOf(name) in FILE_TYPES);
}

export type Paste = {
  id: string;
  title: string;
  source: string;
  bytes: number;
  /** A highlight.js grammar name, "markdown" for rendered Markdown, "binary" for a file. */
  language: string;
  mime: string;
  /** Kept on disk, not in `source` (which is then empty): read it from the raw link. */
  file: boolean;
  createdAt: string;
  expiresAt: string;
};

type Created = {
  id: string;
  token: string;
  title: string;
  language: string;
  mime: string;
  createdAt: string;
  expiresAt: string;
  bytes: number;
  file: boolean;
  sensitive: SensitiveReport;
};

/**
 * A file name for the paste. A given title keeps its own extension, or gains the
 * language's when it has none; without a title, Markdown is named after its first
 * heading and anything else is paste.<ext>.
 */
export function pasteTitle(value: unknown, source: string, language = MARKDOWN): string {
  const extension = languageOf(language).extensions[0]!;
  if (typeof value === "string" && value.trim()) {
    const title = text(value, "Title").replace(/[/\\]/g, "-");
    return /\.[A-Za-z0-9]{1,12}$/.test(title) || /^(dockerfile|makefile)$/i.test(title) ? title : `${title}.${extension}`;
  }
  if (language !== MARKDOWN) return `paste.${extension}`;
  const heading = source.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (!heading) return "paste.md";
  return `${heading.replace(/[/\\]/g, "-").slice(0, 80)}.md`;
}

/** The language of a paste: an explicit request wins, then the name, then the content. */
export function pasteLanguage(args: Record<string, unknown>, source: string): string {
  if (args.language !== undefined && args.language !== null && args.language !== "") {
    if (typeof args.language !== "string" || languageOf(args.language).id !== args.language)
      throw new HttpError(400, "language must be a supported highlight name such as json, javascript, python or markdown.");
    return args.language;
  }
  return detectLanguage(typeof args.title === "string" ? args.title : undefined, source);
}

/** Removes expired pastes, and the files on disk behind those that were files. */
export function purgePastes(store: Store, dir?: string) {
  const stamp = now();
  if (dir)
    for (const row of store.all<{ id: string }>("SELECT id FROM pastes WHERE expiresAt<=? AND file=1", stamp))
      rmSync(join(dir, row.id), { force: true });
  store.run("DELETE FROM pastes WHERE expiresAt<=?", stamp);
}

/** Bytes every live file paste takes on disk. */
export function pasteStorageUsed(store: Store): number {
  return store.get<{ total: number }>("SELECT COALESCE(SUM(bytes),0) AS total FROM pastes WHERE file=1")!.total;
}

function expiryOf(args: Record<string, unknown>): string {
  const expiresIn = args.expiresIn ?? PASTE_DEFAULT_EXPIRY;
  if (typeof expiresIn !== "string" || !(expiresIn in PASTE_EXPIRIES))
    throw new HttpError(400, `expiresIn must be one of ${Object.keys(PASTE_EXPIRIES).join(", ")}.`);
  return new Date(Date.now() + PASTE_EXPIRIES[expiresIn]! * 1000).toISOString();
}

export function createPaste(store: Store, args: Record<string, unknown>, dir?: string): Created {
  const source = args.source;
  if (typeof source !== "string" || !source.trim())
    throw new HttpError(400, "A source text is required.");
  const bytes = Buffer.byteLength(source);
  if (bytes > PASTE_MAX_BYTES)
    throw new HttpError(413, `A paste is limited to ${PASTE_MAX_BYTES / 1024} KB as JSON; send larger files as the file itself (up to 2 GB): curl --data-binary @file.`);
  const expiresAt = expiryOf(args);
  // A PDF or image, named as such, arrives as base64 and is stored that way; the page
  // decodes it for the browser's own viewer and the raw route serves the real bytes.
  const binary = binaryType(typeof args.title === "string" ? args.title : undefined);
  if (binary && !/^[A-Za-z0-9+/]+=*\s*$/.test(source.trim()))
    throw new HttpError(400, `A ${binary.label} paste must be sent as base64.`);
  const language = binary ? BINARY : pasteLanguage(args, source);
  const title = binary ? pasteTitle(args.title, source) : pasteTitle(args.title, source, language);
  const token = secret();
  const pasteId = id();
  const createdAt = now();
  store.db.transaction(() => {
    purgePastes(store, dir);
    store.run(
      "INSERT INTO pastes (id,tokenHash,title,source,bytes,language,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?)",
      pasteId,
      checksum(token),
      title,
      source,
      bytes,
      language,
      createdAt,
      expiresAt,
    );
  })();
  // Reported, never refused: the page and the CLI ask before they send, and an API
  // caller decides for itself. A PDF or image is base64, so there is nothing to read.
  const sensitive = binary ? { level: null, findings: [] } : scanSensitive(source);
  return { id: pasteId, token, title, language, mime: pasteMime(title, language), createdAt, expiresAt, bytes, file: false, sensitive };
}

/**
 * A paste kept as a file: an upload too large for the database, or one that is not
 * text. `path` is the received file, moved into `dir` under the paste's id; `head` is
 * its first bytes, enough to tell text from binary and to guess a language.
 */
export function createFilePaste(store: Store, dir: string, args: Record<string, unknown>, path: string, bytes: number, head: Uint8Array): Created {
  const expiresAt = expiryOf(args);
  const name = typeof args.title === "string" && args.title.trim() ? args.title : undefined;
  const sample = new TextDecoder().decode(head);
  const isText = !binaryName(name) && !looksBinary(sample);
  const language = isText ? pasteLanguage(args, sample) : BINARY;
  const title = isText ? pasteTitle(name, sample, language) : name ? text(name, "Title").replace(/[/\\]/g, "-") : "paste.bin";
  const token = secret();
  const pasteId = id();
  const createdAt = now();
  purgePastes(store, dir);
  renameSync(path, join(dir, pasteId));
  try {
    store.run(
      "INSERT INTO pastes (id,tokenHash,title,source,bytes,language,createdAt,expiresAt,file) VALUES (?,?,?,?,?,?,?,?,1)",
      pasteId, checksum(token), title, "", bytes, language, createdAt, expiresAt,
    );
  } catch (error) {
    rmSync(join(dir, pasteId), { force: true });
    throw error;
  }
  // Only the first bytes were read, so a scan would be a guess: a file paste reports nothing.
  return { id: pasteId, token, title, language, mime: pasteMime(title, language), createdAt, expiresAt, bytes, file: true, sensitive: { level: null, findings: [] } };
}

/** The type of a paste's real bytes: the file's own for a PDF, image or media file, else the language's. */
export function pasteMime(title: string, language: string): string {
  const known = binaryType(title)?.mime ?? FILE_TYPES[extensionOf(title)];
  if (known) return known;
  return language === BINARY ? OCTET : languageOf(language).mime;
}

export function readPaste(store: Store, token: string): Paste {
  const paste = store.get<Omit<Paste, "mime" | "file" | "language"> & { language: string | null; file: number }>(
    "SELECT id,title,source,bytes,language,createdAt,expiresAt,file FROM pastes WHERE tokenHash=? AND expiresAt>?",
    checksum(token),
    now(),
  );
  if (!paste) throw new HttpError(404, "This paste does not exist, has expired, or was deleted.");
  // Rows from before languages were stored are Markdown, which is all a paste could be then.
  const language = paste.language ?? MARKDOWN;
  return { ...paste, file: paste.file === 1, language, mime: pasteMime(paste.title, language) };
}

export function deletePaste(store: Store, token: string, dir?: string) {
  const row = store.get<{ id: string; file: number }>("SELECT id,file FROM pastes WHERE tokenHash=?", checksum(token));
  if (!row) throw new HttpError(404, "This paste does not exist, has expired, or was deleted.");
  store.run("DELETE FROM pastes WHERE id=?", row.id);
  if (row.file && dir) rmSync(join(dir, row.id), { force: true });
}
