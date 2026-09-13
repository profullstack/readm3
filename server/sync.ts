import { type SnapshotStore, type StoredSnapshot, KEEP_REVISIONS } from "@profullstack/synconfig/server";
import { Store, now } from "./store.ts";

type Row = Omit<StoredSnapshot, "body"> & { body: string };
export function snapshotStore(store: Store): SnapshotStore {
  store.db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, digest TEXT NOT NULL, host TEXT, version TEXT,
    size INTEGER NOT NULL, body TEXT NOT NULL, savedAt TEXT NOT NULL,
    PRIMARY KEY(userId, revision)
  )`);
  return {
    async latest(userId) {
      const row = store.get<Row>("SELECT revision,digest,host,version,size,body,savedAt FROM snapshots WHERE userId=? ORDER BY revision DESC LIMIT 1", userId);
      return row ? { ...row, body: JSON.parse(row.body) } : null;
    },
    async insert(userId, entry, ifRevision) {
      // The immediate transaction serializes the comparison and insert across connections.
      return store.db.transaction(() => {
        const current = store.get<{ revision: number }>("SELECT COALESCE(MAX(revision),0) AS revision FROM snapshots WHERE userId=?", userId)!.revision;
        if (ifRevision !== null && current !== ifRevision) return { conflict: true as const, revision: current };
        const revision = current + 1;
        const savedAt = now();
        store.run("INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?)", userId, revision, entry.digest, entry.host?.slice(0, 200) ?? null, entry.version, entry.size, JSON.stringify(entry.body), savedAt);
        store.run("DELETE FROM snapshots WHERE userId=? AND revision<=?", userId, revision - KEEP_REVISIONS);
        return { revision, savedAt };
      }).immediate();
    },
    async list(userId, limit) {
      return store.all("SELECT revision,digest,host,version,size,savedAt FROM snapshots WHERE userId=? ORDER BY revision DESC LIMIT ?", userId, limit);
    },
  };
}
