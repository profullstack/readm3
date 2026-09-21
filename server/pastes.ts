/**
 * Anonymous pastes: a Markdown document behind a secret link, no account needed.
 *
 * A paste is not a document. It has no owner, no organization, no versions and no
 * permissions; the 43-character token in its URL is the whole capability, and only
 * its hash is stored, so a paste cannot be listed or recovered once the link is lost.
 * Every paste expires, seven days by default and thirty at most, and expired rows are
 * purged the next time one is created. Whoever holds the link can read or delete it.
 */
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
  createdAt: string;
  expiresAt: string;
};

/** A file name for the paste: the given title, else the first heading, else paste.md. */
export function pasteTitle(value: unknown, source: string): string {
  if (typeof value === "string" && value.trim()) {
    const title = text(value, "Title").replace(/[/\\]/g, "-");
    return /\.(md|markdown)$/i.test(title) ? title : `${title}.md`;
  }
  const heading = source.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (!heading) return "paste.md";
  return `${heading.replace(/[/\\]/g, "-").slice(0, 80)}.md`;
}

export function purgePastes(store: Store) {
  store.run("DELETE FROM pastes WHERE expiresAt<=?", now());
}

export function createPaste(
  store: Store,
  args: Record<string, unknown>,
): { id: string; token: string; title: string; createdAt: string; expiresAt: string; bytes: number } {
  const source = args.source;
  if (typeof source !== "string" || !source.trim())
    throw new HttpError(400, "Markdown source is required.");
  const bytes = Buffer.byteLength(source);
  if (bytes > PASTE_MAX_BYTES)
    throw new HttpError(413, `A paste is limited to ${PASTE_MAX_BYTES / 1024} KB.`);
  const expiresIn = args.expiresIn ?? PASTE_DEFAULT_EXPIRY;
  if (typeof expiresIn !== "string" || !(expiresIn in PASTE_EXPIRIES))
    throw new HttpError(400, `expiresIn must be one of ${Object.keys(PASTE_EXPIRIES).join(", ")}.`);
  const title = pasteTitle(args.title, source);
  const token = secret();
  const pasteId = id();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + PASTE_EXPIRIES[expiresIn]! * 1000).toISOString();
  store.db.transaction(() => {
    purgePastes(store);
    store.run(
      "INSERT INTO pastes (id,tokenHash,title,source,bytes,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?)",
      pasteId,
      checksum(token),
      title,
      source,
      bytes,
      createdAt,
      expiresAt,
    );
  })();
  return { id: pasteId, token, title, createdAt, expiresAt, bytes };
}

export function readPaste(store: Store, token: string): Paste {
  const paste = store.get<Paste>(
    "SELECT id,title,source,bytes,createdAt,expiresAt FROM pastes WHERE tokenHash=? AND expiresAt>?",
    checksum(token),
    now(),
  );
  if (!paste) throw new HttpError(404, "This paste does not exist, has expired, or was deleted.");
  return paste;
}

export function deletePaste(store: Store, token: string) {
  const result = store.run("DELETE FROM pastes WHERE tokenHash=?", checksum(token));
  if (!result.changes) throw new HttpError(404, "This paste does not exist, has expired, or was deleted.");
}
