import {
  Store,
  HttpError,
  checksum,
  equalSecret,
  id,
  now,
  secret,
  text,
  type Doc,
  type User,
} from "./store.ts";

type Args = Record<string, unknown>;
const role = (value: unknown, allowed: string[]) => {
  const selected = String(value);
  if (!allowed.includes(selected))
    throw new HttpError(400, `Role must be ${allowed.join(" or ")}.`);
  return selected;
};
const key = (args: Args, name: string) => text(args[name], name);
function page(args: Args) {
  const limit = Number(args.limit ?? 1000),
    offset = Number(args.offset ?? 0);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new HttpError(400, "Use limit 1–1000 and a nonnegative offset.");
  return [limit, offset];
}

export function operate(
  store: Store,
  user: User,
  operation: string,
  args: Args,
  origin: string,
): unknown {
  const orgId = () => key(args, "orgId");
  const docId = () => key(args, "documentId");
  const owner = () => store.document(user, docId(), "owner");
  const team = () => {
    const t = store.get<{ id: string; orgId: string }>(
      "SELECT * FROM teams WHERE id=?",
      key(args, "teamId"),
    );
    if (!t) throw new HttpError(404, "Team not found.");
    store.orgAccess(user, t.orgId, true);
    return t;
  };
  switch (operation) {
    case "account_me":
      return user;
    case "organizations_list":
      return store.all(
        user.admin
          ? "SELECT o.*,'owner' AS role FROM organizations o ORDER BY o.createdAt DESC"
          : "SELECT o.*,m.role FROM organizations o JOIN members m ON m.orgId=o.id WHERE m.userId=? ORDER BY o.createdAt DESC",
        ...(user.admin ? [] : [user.id]),
      );
    case "organizations_create": {
      const org = {
        id: id(),
        name: text(args.name, "Organization name"),
        createdAt: now(),
        role: "owner",
      };
      if (
        store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM members WHERE userId=? AND role='owner'",
          user.id,
        )!.count >= 20
      )
        throw new HttpError(413, "Organization limit reached.");
      store.db.transaction(() => {
        store.run(
          "INSERT INTO organizations VALUES (?,?,?)",
          org.id,
          org.name,
          org.createdAt,
        );
        store.run(
          "INSERT INTO members VALUES (?,?,?)",
          org.id,
          user.id,
          "owner",
        );
      })();
      return org;
    }
    case "organizations_update":
      store.orgAccess(user, orgId(), true);
      store.run(
        "UPDATE organizations SET name=? WHERE id=?",
        text(args.name, "Organization name"),
        orgId(),
      );
      return { ok: true };
    case "organizations_delete": {
      store.orgAccess(user, orgId(), true);
      if (store.get("SELECT id FROM documents WHERE orgId=? LIMIT 1", orgId()))
        throw new HttpError(
          409,
          "Delete or move all documents before deleting this organization.",
        );
      store.run("DELETE FROM organizations WHERE id=?", orgId());
      return { ok: true };
    }
    case "members_list":
      store.orgAccess(user, orgId());
      return store.all(
        "SELECT u.id,u.username,u.displayName,m.role FROM members m JOIN users u ON u.id=m.userId WHERE m.orgId=? ORDER BY u.username",
        orgId(),
      );
    case "members_update":
    case "members_remove": {
      store.orgAccess(user, orgId(), true);
      const userId = key(args, "userId");
      const member = store.get<{ role: string }>(
        "SELECT role FROM members WHERE orgId=? AND userId=?",
        orgId(),
        userId,
      );
      if (!member) throw new HttpError(404, "Member not found.");
      const next =
        operation === "members_remove"
          ? "remove"
          : role(args.role, ["owner", "member"]);
      if (
        member.role === "owner" &&
        next !== "owner" &&
        store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM members WHERE orgId=? AND role='owner'",
          orgId(),
        )!.count === 1
      )
        throw new HttpError(
          409,
          "An organization must keep at least one owner.",
        );
      if (next === "remove")
        store.db.transaction(() => {
          store.run(
            "DELETE FROM team_members WHERE userId=? AND teamId IN (SELECT id FROM teams WHERE orgId=?)",
            userId,
            orgId(),
          );
          store.run(
            "DELETE FROM members WHERE orgId=? AND userId=?",
            orgId(),
            userId,
          );
        })();
      else
        store.run(
          "UPDATE members SET role=? WHERE orgId=? AND userId=?",
          next,
          orgId(),
          userId,
        );
      return { ok: true };
    }
    case "invitations_list":
      store.orgAccess(user, orgId(), true);
      return store.all(
        "SELECT id,role,teamId,expiresAt,createdAt FROM invitations WHERE orgId=? AND expiresAt>?",
        orgId(),
        now(),
      );
    case "invitations_create": {
      store.orgAccess(user, orgId(), true);
      const assignedRole = role(args.role ?? "member", ["member", "owner"]);
      const teamId = args.teamId ? key(args, "teamId") : null;
      store.validateTeam(user, orgId(), teamId);
      const token = secret();
      const inviteId = id();
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      store.run(
        "INSERT INTO invitations VALUES (?,?,?,?,?,?,?)",
        inviteId,
        orgId(),
        checksum(token),
        assignedRole,
        teamId,
        expiresAt,
        now(),
      );
      return {
        id: inviteId,
        role: assignedRole,
        expiresAt,
        url: `${origin}/admin#invite=${token}`,
      };
    }
    case "invitations_revoke": {
      const invite = store.get<{ orgId: string }>(
        "SELECT orgId FROM invitations WHERE id=?",
        key(args, "invitationId"),
      );
      if (!invite) throw new HttpError(404, "Invitation not found.");
      store.orgAccess(user, invite.orgId, true);
      store.run(
        "DELETE FROM invitations WHERE id=?",
        key(args, "invitationId"),
      );
      return { ok: true };
    }
    case "invitations_accept":
      return store.db.transaction(() => {
        const invite = store.get<{
          id: string;
          orgId: string;
          role: string;
          teamId: string | null;
        }>(
          "SELECT * FROM invitations WHERE tokenHash=? AND expiresAt>?",
          checksum(key(args, "token")),
          now(),
        );
        if (!invite)
          throw new HttpError(
            404,
            "Invitation has expired or already been used.",
          );
        // Accepting an invitation never demotes an existing organization owner.
        store.run(
          "INSERT INTO members VALUES (?,?,?) ON CONFLICT(orgId,userId) DO UPDATE SET role=CASE WHEN members.role='owner' THEN 'owner' ELSE excluded.role END",
          invite.orgId,
          user.id,
          invite.role,
        );
        if (invite.teamId)
          store.run(
            "INSERT OR IGNORE INTO team_members VALUES (?,?)",
            invite.teamId,
            user.id,
          );
        store.run("DELETE FROM invitations WHERE id=?", invite.id);
        return { orgId: invite.orgId };
      })();
    case "teams_list":
      store.orgAccess(user, orgId());
      return store.all(
        "SELECT * FROM teams WHERE orgId=? ORDER BY name",
        orgId(),
      );
    case "teams_create": {
      store.orgAccess(user, orgId(), true);
      const teamId = id();
      store.run(
        "INSERT INTO teams VALUES (?,?,?,?)",
        teamId,
        orgId(),
        text(args.name, "Team name"),
        now(),
      );
      return { id: teamId, name: args.name, orgId: orgId() };
    }
    case "teams_update": {
      const t = team();
      store.run(
        "UPDATE teams SET name=? WHERE id=?",
        text(args.name, "Team name"),
        t.id,
      );
      return { ok: true };
    }
    case "teams_delete": {
      const t = team();
      if (store.get("SELECT id FROM documents WHERE teamId=? LIMIT 1", t.id))
        throw new HttpError(
          409,
          "Move documents out of this team before deleting it.",
        );
      store.run("DELETE FROM teams WHERE id=?", t.id);
      return { ok: true };
    }
    case "team_members_list": {
      const t = store.get<{ orgId: string }>(
        "SELECT orgId FROM teams WHERE id=?",
        key(args, "teamId"),
      );
      if (!t) throw new HttpError(404, "Team not found.");
      store.orgAccess(user, t.orgId);
      return store.all(
        "SELECT u.id,u.username,u.displayName FROM team_members m JOIN users u ON u.id=m.userId WHERE teamId=?",
        key(args, "teamId"),
      );
    }
    case "team_members_add": {
      const t = team();
      const userId = key(args, "userId");
      if (
        !store.get(
          "SELECT userId FROM members WHERE orgId=? AND userId=?",
          t.orgId,
          userId,
        )
      )
        throw new HttpError(400, "Add this user to the organization first.");
      store.run(
        "INSERT OR IGNORE INTO team_members VALUES (?,?)",
        t.id,
        userId,
      );
      return { ok: true };
    }
    case "team_members_remove": {
      const t = team();
      store.run(
        "DELETE FROM team_members WHERE teamId=? AND userId=?",
        t.id,
        key(args, "userId"),
      );
      return { ok: true };
    }
    case "documents_list": {
      const accessible = user.admin
        ? "1=1"
        : `(d.ownerId=? OR EXISTS (SELECT 1 FROM permissions p WHERE p.documentId=d.id AND p.userId=?) OR (d.access!='private' AND EXISTS (SELECT 1 FROM members m WHERE m.orgId=d.orgId AND m.userId=?) AND (d.teamId IS NULL OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.teamId=d.teamId AND tm.userId=?))))`;
      const values: string[] = user.admin
        ? []
        : [user.id, user.id, user.id, user.id];
      if (args.orgId) values.push(orgId());
      if (args.search) values.push(text(args.search, "Search"));
      const docs = store.all<Doc>(
        `SELECT d.*,u.username AS ownerUsername FROM documents d JOIN users u ON u.id=d.ownerId WHERE ${accessible}${args.orgId ? " AND d.orgId=?" : ""}${args.search ? " AND instr(lower(d.title),lower(?))>0" : ""} ORDER BY d.updatedAt DESC,d.id DESC LIMIT ? OFFSET ?`,
        ...values,
        ...page(args),
      );
      return docs.map((doc) => ({
        ...doc,
        canEdit: store.access(user, doc) !== "view",
        canManage: store.access(user, doc) === "owner",
      }));
    }
    case "documents_create":
      return store.createDocument(user, args);
    case "documents_get":
      return store.view(user, docId());
    case "documents_update":
      return store.updateDocument(user, docId(), args);
    case "documents_delete": {
      const doc = owner();
      store.run("DELETE FROM documents WHERE id=?", doc.id);
      return { ok: true };
    }
    case "documents_transfer": {
      const doc = owner();
      const next = store.get<User>(
        "SELECT id,username,displayName,admin,createdAt FROM users WHERE username=?",
        text(args.username, "Username").toLowerCase(),
      );
      if (!next) throw new HttpError(404, "User not found.");
      store.run("UPDATE documents SET ownerId=? WHERE id=?", next.id, doc.id);
      return { ok: true };
    }
    case "versions_list":
      owner();
      return store.all(
        "SELECT v.id,v.checksum,v.title,v.parentId,v.createdAt,COALESCE(u.displayName,'Link editor') AS author FROM versions v LEFT JOIN users u ON u.id=v.authorId WHERE documentId=? ORDER BY v.rowid DESC LIMIT 1000",
        docId(),
      );
    case "versions_get":
      owner();
      return store.view(user, docId(), key(args, "versionId"));
    case "versions_restore": {
      owner();
      const version = store.get<{ source: string; title: string }>(
        "SELECT source,title FROM versions WHERE id=? AND documentId=?",
        key(args, "versionId"),
        docId(),
      );
      if (!version) throw new HttpError(404, "Version not found.");
      return store.updateDocument(user, docId(), {
        ...version,
        baseVersion: args.baseVersion,
      });
    }
    case "permissions_list":
      owner();
      return store.all(
        "SELECT p.userId,p.role,u.username,u.displayName FROM permissions p JOIN users u ON u.id=p.userId WHERE documentId=?",
        docId(),
      );
    case "permissions_set": {
      const doc = owner();
      const target = store.get<{ id: string }>(
        "SELECT id FROM users WHERE username=?",
        text(args.username, "Username").toLowerCase(),
      );
      if (!target) throw new HttpError(404, "User not found.");
      if (target.id === doc.ownerId)
        throw new HttpError(400, "The file owner already has full access.");
      store.run(
        "INSERT INTO permissions VALUES (?,?,?) ON CONFLICT(documentId,userId) DO UPDATE SET role=excluded.role",
        doc.id,
        target.id,
        role(args.role, ["view", "edit"]),
      );
      return { ok: true };
    }
    case "permissions_remove":
      owner();
      store.run(
        "DELETE FROM permissions WHERE documentId=? AND userId=?",
        docId(),
        key(args, "userId"),
      );
      return { ok: true };
    case "shares_list":
      owner();
      return store.all(
        "SELECT id,label,role,versionId,expiresAt,createdAt FROM shares WHERE documentId=? ORDER BY createdAt DESC",
        docId(),
      );
    case "shares_create": {
      const doc = owner();
      const access = role(args.role ?? "view", ["view", "edit"]);
      const versionId = args.versionId ? key(args, "versionId") : null;
      if (
        versionId &&
        !store.get(
          "SELECT id FROM versions WHERE id=? AND documentId=?",
          versionId,
          doc.id,
        )
      )
        throw new HttpError(404, "Version not found.");
      if (versionId && access === "edit")
        throw new HttpError(
          400,
          "A pinned version can only be shared for viewing.",
        );
      const expiresAt = args.expiresAt
        ? text(args.expiresAt, "Expiry", 50)
        : null;
      if (
        expiresAt &&
        (!Number.isFinite(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= Date.now())
      )
        throw new HttpError(400, "Expiry must be a future ISO date.");
      const normalized = expiresAt ? new Date(expiresAt).toISOString() : null;
      const token = secret();
      const shareId = id();
      store.run(
        "INSERT INTO shares VALUES (?,?,?,?,?,?,?,?)",
        shareId,
        doc.id,
        checksum(token),
        versionId,
        access,
        text(args.label ?? "Shared link", "Label"),
        normalized,
        now(),
      );
      return {
        id: shareId,
        role: access,
        versionId,
        expiresAt: normalized,
        url: `${origin}/s/${token}`,
      };
    }
    case "shares_revoke":
      owner();
      store.run(
        "DELETE FROM shares WHERE id=? AND documentId=?",
        key(args, "shareId"),
        docId(),
      );
      return { ok: true };
    case "tokens_list":
      return store.all(
        "SELECT id,label,expiresAt,createdAt FROM sessions WHERE userId=? AND kind='api' AND expiresAt>?",
        user.id,
        now(),
      );
    case "tokens_create":
      return store.session(
        user,
        "api",
        text(args.label ?? "CLI and MCP", "Token label"),
      );
    case "tokens_revoke":
      store.run(
        "DELETE FROM sessions WHERE id=? AND userId=? AND kind='api'",
        key(args, "tokenId"),
        user.id,
      );
      return { ok: true };
    case "admin_claim": {
      const configured = process.env.READM3_ADMIN_BOOTSTRAP_SECRET;
      if (!configured || !equalSecret(key(args, "token"), configured))
        throw new HttpError(403, "Invalid administrator setup link.");
      store.db.transaction(() => {
        if (store.get("SELECT key FROM settings WHERE key='admin_claimed'"))
          throw new HttpError(
            409,
            "Administrator access has already been claimed.",
          );
        store.run("UPDATE users SET admin=1 WHERE id=?", user.id);
        store.run("INSERT INTO settings VALUES ('admin_claimed',?)", user.id);
      })();
      return store.user(user.id);
    }
    case "admin_users":
      if (!user.admin)
        throw new HttpError(403, "Super administrator access required.");
      return store.all(
        "SELECT id,username,displayName,admin,createdAt FROM users ORDER BY createdAt DESC LIMIT 1000",
      );
    default:
      throw new HttpError(404, "Unknown operation.");
  }
}
