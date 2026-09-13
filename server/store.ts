import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type User = {
  id: string;
  username: string;
  displayName: string;
  admin: number;
  createdAt: string;
};
export type Doc = {
  id: string;
  ownerId: string;
  orgId: string;
  teamId: string | null;
  access: string;
  title: string;
  currentVersion: string;
  createdAt: string;
  updatedAt: string;
};
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const id = () => randomBytes(12).toString("base64url");
export const secret = () => randomBytes(32).toString("base64url");
export const checksum = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export const equalSecret = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(checksum(a)), Buffer.from(checksum(b)));
export function requireValue(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(400, `${name} must be 1–${max} characters.`);
  return value.trim();
}
export function source(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 1024 * 1024)
    throw new HttpError(400, "Markdown source must be text, up to 1 MB.");
  return value;
}

export class Store {
  db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, displayName TEXT NOT NULL, passwordHash TEXT NOT NULL, recoveryHash TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, tokenHash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(orgId,userId));
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, name TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_members (teamId TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(teamId,userId));
      CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, tokenHash TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), teamId TEXT REFERENCES teams(id) ON DELETE CASCADE, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES users(id), orgId TEXT NOT NULL REFERENCES organizations(id), teamId TEXT REFERENCES teams(id), access TEXT NOT NULL DEFAULT 'private', title TEXT NOT NULL, currentVersion TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, source TEXT NOT NULL, title TEXT NOT NULL, checksum TEXT NOT NULL, authorId TEXT REFERENCES users(id), parentId TEXT, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, tokenHash TEXT UNIQUE NOT NULL, versionId TEXT REFERENCES versions(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'view', label TEXT NOT NULL, expiresAt TEXT, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permissions (documentId TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('view','edit')), PRIMARY KEY(documentId,userId));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_org ON documents(orgId);
      CREATE INDEX IF NOT EXISTS documents_owner ON documents(ownerId);
      CREATE INDEX IF NOT EXISTS versions_document ON versions(documentId,createdAt);
      CREATE INDEX IF NOT EXISTS shares_document ON shares(documentId);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
    `);
  }
  get<T>(sql: string, ...args: (string | number | null)[]): T | null {
    return this.db.query(sql).get(...args) as T | null;
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.query(sql).run(...args);
  }
  user(userId: string): User {
    const u = this.get<User>(
      "SELECT id,username,displayName,admin,createdAt FROM users WHERE id=?",
      userId,
    );
    if (!u) throw new HttpError(401, "Sign in to continue.");
    return u;
  }
  authenticate(token: string): User | null {
    const session = this.get<{ userId: string }>(
      "SELECT userId FROM sessions WHERE tokenHash=? AND expiresAt>?",
      checksum(token),
      now(),
    );
    return session ? this.user(session.userId) : null;
  }
  session(user: User, kind = "browser", label = "Browser session") {
    const token = secret();
    const sessionId = id();
    const expiresAt = new Date(
      Date.now() + (kind === "api" ? 90 : 30) * 86400000,
    ).toISOString();
    this.run("DELETE FROM sessions WHERE expiresAt<=?", now());
    this.run(
      "INSERT INTO sessions VALUES (?,?,?,?,?,?,?)",
      sessionId,
      user.id,
      checksum(token),
      kind,
      label,
      expiresAt,
      now(),
    );
    return { id: sessionId, token, expiresAt, label };
  }
  orgRole(user: User, orgId: string) {
    if (
      user.admin &&
      this.get("SELECT id FROM organizations WHERE id=?", orgId)
    )
      return "owner";
    return this.get<{ role: string }>(
      "SELECT role FROM members WHERE orgId=? AND userId=?",
      orgId,
      user.id,
    )?.role;
  }
  orgAccess(user: User, orgId: string, owner = false) {
    const role = this.orgRole(user, orgId);
    if (!role || (owner && role !== "owner"))
      throw new HttpError(
        403,
        owner
          ? "Only organization owners can manage membership and teams."
          : "Organization access required.",
      );
  }
  access(
    user: User | null,
    doc: Doc,
    shareToken?: string,
  ): "owner" | "edit" | "view" | null {
    if (user && (user.admin || user.id === doc.ownerId)) return "owner";
    let role: "edit" | "view" | null = null;
    if (user) {
      role =
        this.get<{ role: "edit" | "view" }>(
          "SELECT role FROM permissions WHERE documentId=? AND userId=?",
          doc.id,
          user.id,
        )?.role ?? null;
      const member = this.orgRole(user, doc.orgId);
      const team =
        !doc.teamId ||
        this.get(
          "SELECT userId FROM team_members WHERE teamId=? AND userId=?",
          doc.teamId,
          user.id,
        );
      if (member && team && doc.access !== "private" && role !== "edit")
        role = doc.access as "view" | "edit";
    }
    if (shareToken) {
      const link = this.get<{
        role: "edit" | "view";
        versionId: string | null;
      }>(
        "SELECT role,versionId FROM shares WHERE documentId=? AND tokenHash=? AND (expiresAt IS NULL OR expiresAt>?)",
        doc.id,
        checksum(shareToken),
        now(),
      );
      if (link && role !== "edit") role = link.versionId ? "view" : link.role;
    }
    return role;
  }
  document(
    user: User | null,
    documentId: string,
    needed: "view" | "edit" | "owner" = "view",
    shareToken?: string,
  ): Doc {
    const doc = this.get<Doc>("SELECT * FROM documents WHERE id=?", documentId);
    if (!doc) throw new HttpError(404, "Document not found.");
    const role = this.access(user, doc, shareToken);
    if (!role) throw new HttpError(404, "Document not found.");
    if (needed === "owner" && role !== "owner")
      throw new HttpError(
        403,
        "Only the file owner or super administrator can manage this document.",
      );
    if (needed === "edit" && role === "view")
      throw new HttpError(403, "This document is shared for viewing only.");
    return doc;
  }
  view(
    user: User | null,
    documentId: string,
    versionId?: string,
    shareToken?: string,
  ) {
    const doc = this.document(user, documentId, "view", shareToken);
    const version = this.get<Record<string, unknown>>(
      "SELECT v.*,COALESCE(u.displayName,'Link editor') AS author FROM versions v LEFT JOIN users u ON u.id=v.authorId WHERE v.documentId=? AND v.id=?",
      doc.id,
      versionId || doc.currentVersion,
    );
    if (!version) throw new HttpError(404, "Version not found.");
    const role = this.access(user, doc, shareToken);
    return {
      ...doc,
      ...(versionId ? { title: version.title as string } : {}),
      version,
      canEdit: role === "owner" || role === "edit",
      canManage: role === "owner",
    };
  }
  validateTeam(user: User, orgId: string, teamId: string | null) {
    if (!teamId) return;
    if (!this.get("SELECT id FROM teams WHERE id=? AND orgId=?", teamId, orgId))
      throw new HttpError(400, "Team must belong to this organization.");
    if (
      !user.admin &&
      this.orgRole(user, orgId) !== "owner" &&
      !this.get(
        "SELECT userId FROM team_members WHERE teamId=? AND userId=?",
        teamId,
        user.id,
      )
    )
      throw new HttpError(403, "Join the team before adding a document to it.");
  }
  createDocument(user: User, args: Record<string, unknown>) {
    const orgId = text(args.orgId, "orgId");
    this.orgAccess(user, orgId);
    const title = text(args.title, "Title");
    const markdown = source(args.source);
    const access = args.access ?? "private";
    if (!["private", "view", "edit"].includes(String(access)))
      throw new HttpError(400, "Access must be private, view, or edit.");
    const teamId = args.teamId ? text(args.teamId, "teamId") : null;
    this.validateTeam(user, orgId, teamId);
    if (
      this.get<{ total: number }>(
        "SELECT COUNT(*) AS total FROM documents WHERE ownerId=?",
        user.id,
      )!.total >= 1000
    )
      throw new HttpError(413, "Document limit reached (1,000 per owner).");
    const bytes = this.get<{ total: number }>(
      "SELECT COALESCE(SUM(length(CAST(v.source AS BLOB))),0) AS total FROM versions v JOIN documents d ON d.id=v.documentId WHERE d.ownerId=?",
      user.id,
    )!.total;
    if (bytes + Buffer.byteLength(markdown) > 100 * 1024 * 1024)
      throw new HttpError(
        413,
        "Version storage limit reached (100 MB per owner).",
      );
    const documentId = id();
    const versionId = id();
    const stamp = now();
    this.db.transaction(() => {
      this.run(
        "INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)",
        documentId,
        user.id,
        orgId,
        teamId,
        String(access),
        title,
        versionId,
        stamp,
        stamp,
      );
      this.run(
        "INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)",
        versionId,
        documentId,
        markdown,
        title,
        checksum(markdown),
        user.id,
        null,
        stamp,
      );
    })();
    return this.view(user, documentId);
  }
  updateDocument(
    user: User | null,
    documentId: string,
    args: Record<string, unknown>,
    shareToken?: string,
  ) {
    return this.db.transaction(() => {
      const doc = this.document(user, documentId, "edit", shareToken);
      const managing = this.access(user, doc, shareToken) === "owner";
      if (
        !managing &&
        (args.teamId !== undefined ||
          args.access !== undefined ||
          args.ownerId !== undefined)
      )
        throw new HttpError(
          403,
          "Only the owner can change document permissions.",
        );
      if (typeof args.baseVersion !== "string")
        throw new HttpError(
          428,
          "baseVersion is required to prevent overwriting another save.",
        );
      if (args.baseVersion !== doc.currentVersion)
        throw new HttpError(
          409,
          "This document changed since you opened it. Reload or copy your draft before trying again.",
          { currentVersion: doc.currentVersion },
        );
      const current = this.get<{ source: string }>(
        "SELECT source FROM versions WHERE id=?",
        doc.currentVersion,
      )!;
      const title =
        args.title === undefined ? doc.title : text(args.title, "Title");
      const markdown =
        args.source === undefined ? current.source : source(args.source);
      const teamId =
        args.teamId === undefined
          ? doc.teamId
          : args.teamId
            ? text(args.teamId, "teamId")
            : null;
      if (user && args.teamId !== undefined)
        this.validateTeam(user, doc.orgId, teamId);
      const access = args.access ?? doc.access;
      if (!["private", "view", "edit"].includes(String(access)))
        throw new HttpError(400, "Access must be private, view, or edit.");
      const bytes = this.get<{ total: number }>(
        "SELECT COALESCE(SUM(length(CAST(v.source AS BLOB))),0) AS total FROM versions v JOIN documents d ON d.id=v.documentId WHERE d.ownerId=?",
        doc.ownerId,
      )!.total;
      if (bytes + Buffer.byteLength(markdown) > 100 * 1024 * 1024)
        throw new HttpError(
          413,
          "Version storage limit reached (100 MB per owner).",
        );
      const versionId = id();
      const stamp = now();
      this.run(
        "INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)",
        versionId,
        doc.id,
        markdown,
        title,
        checksum(markdown),
        user?.id ?? null,
        doc.currentVersion,
        stamp,
      );
      this.run(
        "UPDATE documents SET title=?,teamId=?,access=?,currentVersion=?,updatedAt=? WHERE id=?",
        title,
        teamId,
        String(access),
        versionId,
        stamp,
        doc.id,
      );
      return this.view(user, doc.id, undefined, shareToken);
    })();
  }
  close() {
    this.db.close();
  }
}
