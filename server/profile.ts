/**
 * The shared Profullstack profile (@profullstack/profile): email, first and last
 * name, company domain, job title and LinkedIn URL, in the package's own
 * `user_profiles` table keyed by users.id. Private to the account: nothing here is
 * shown to other people. One store per database, created and migrated on first use
 * the way the rest of the schema is.
 */
import type { Database } from "bun:sqlite";
import { createProfileStore, migrate, splitFullName, type ProfileStore } from "@profullstack/profile";

const stores = new WeakMap<Database, { store: ProfileStore; ready: Promise<ProfileStore> }>();

/** The profile store for this database; `ready` resolves once its table exists. */
export function profiles(db: Database) {
  let entry = stores.get(db);
  if (!entry) {
    const store = createProfileStore(db, { keyType: "text" });
    const ready = migrate(store).then(async () => {
      await backfill(db, store);
      return store;
    });
    ready.catch(error => console.error("Profile migration failed", error instanceof Error ? error.message : error));
    entry = { store, ready };
    stores.set(db, entry);
  }
  return entry;
}

/**
 * One-time and idempotent: a display name someone typed as "First Last" becomes the
 * profile's names. A single word, or the email's local part (the default name of an
 * email signup), is a handle, not a name, and is left alone. fillBlanks never
 * overwrites what a person saved.
 */
async function backfill(db: Database, store: ProfileStore) {
  const rows = db.query(`SELECT u.id, u.displayName, e.email FROM users u LEFT JOIN account_emails e ON e.userId=u.id
    WHERE instr(trim(u.displayName), ' ')>0 AND NOT EXISTS (SELECT 1 FROM user_profiles p WHERE p.user_id=u.id)`)
    .all() as { id: string; displayName: string; email: string | null }[];
  for (const row of rows) {
    if (row.email && row.displayName.trim().toLowerCase() === row.email.split("@")[0]) continue;
    const name = splitFullName(row.displayName);
    try { await store.fillBlanks(row.id, { ...name, ...(row.email ? { email: row.email } : {}) }); }
    catch { /* a name the validator refuses (a link, say) is skipped */ }
  }
}
