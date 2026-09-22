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
 */
import { binaryType, detectLanguage, languageOf, MARKDOWN } from "../src/code.ts";

/** The language stored for a PDF or image paste, whose source is base64 rather than text. */
export const BINARY = "binary";
import { HttpError, Store, checksum, id, now, secret, text } from "./store.ts";

export const PASTE_MAX_BYTES = 256 * 1024;
export const PASTE_EXPIRIES: Record<string, number> = {
  "1h": 3600,
  "1d": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
};
export const PASTE_DEFAULT_EXPIRY = "7d";

export type Paste = {
  id: string;
  title: string;
  source: string;
  bytes: number;
  /** A highlight.js grammar name, "markdown" for rendered Markdown. */
  language: string;
  mime: string;
  createdAt: string;
  expiresAt: string;
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

export function purgePastes(store: Store) {
  store.run("DELETE FROM pastes WHERE expiresAt<=?", now());
}

export function createPaste(
  store: Store,
  args: Record<string, unknown>,
): { id: string; token: string; title: string; language: string; mime: string; createdAt: string; expiresAt: string; bytes: number } {
  const source = args.source;
  if (typeof source !== "string" || !source.trim())
    throw new HttpError(400, "A source text is required.");
  const bytes = Buffer.byteLength(source);
  if (bytes > PASTE_MAX_BYTES)
    throw new HttpError(413, `A paste is limited to ${PASTE_MAX_BYTES / 1024} KB.`);
  const expiresIn = args.expiresIn ?? PASTE_DEFAULT_EXPIRY;
  if (typeof expiresIn !== "string" || !(expiresIn in PASTE_EXPIRIES))
    throw new HttpError(400, `expiresIn must be one of ${Object.keys(PASTE_EXPIRIES).join(", ")}.`);
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
  const expiresAt = new Date(Date.now() + PASTE_EXPIRIES[expiresIn]! * 1000).toISOString();
  store.db.transaction(() => {
    purgePastes(store);
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
  return { id: pasteId, token, title, language, mime: pasteMime(title, language), createdAt, expiresAt, bytes };
}

/** The type of a paste's real bytes: the binary's own for a PDF or image, else the language's. */
export function pasteMime(title: string, language: string): string {
  return binaryType(title)?.mime ?? languageOf(language).mime;
}

export function readPaste(store: Store, token: string): Paste {
  const paste = store.get<Omit<Paste, "mime"> & { language: string | null }>(
    "SELECT id,title,source,bytes,language,createdAt,expiresAt FROM pastes WHERE tokenHash=? AND expiresAt>?",
    checksum(token),
    now(),
  );
  if (!paste) throw new HttpError(404, "This paste does not exist, has expired, or was deleted.");
  // Rows from before languages were stored are Markdown, which is all a paste could be then.
  const language = paste.language ?? MARKDOWN;
  return { ...paste, language, mime: pasteMime(paste.title, language) };
}

export function deletePaste(store: Store, token: string) {
  const result = store.run("DELETE FROM pastes WHERE tokenHash=?", checksum(token));
  if (!result.changes) throw new HttpError(404, "This paste does not exist, has expired, or was deleted.");
}
