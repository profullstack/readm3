import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, checksum, id } from "../store.ts";
import { createApi } from "../api.ts";

function fixture(path = ":memory:") {
  const store = new Store(path);
  const api = createApi(store, "http://localhost");
  const ip = id();
  async function call(
    route: string,
    method = "GET",
    data?: unknown,
    credential = "",
    origin = "http://localhost",
  ) {
    const response = (await api(
      new Request("http://localhost/api/v1/" + route, {
        method,
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
      ip,
    ))!;
    return {
      status: response.status,
      data: (await response.json()) as any,
      response,
    };
  }
  async function account(
    name = "user" + id().replace(/-/g, "_").toLowerCase(),
  ) {
    const created = await call("auth/register", "POST", {
      username: name,
      password: "correct horse battery staple",
    });
    expect(created.status).toBe(201);
    const token = created.response.headers
      .get("set-cookie")!
      .match(/readm3_session=([^;]+)/)![1];
    const action = (operation: string, args: Record<string, unknown> = {}) =>
      call("actions", "POST", { operation, args }, token);
    const org = (await action("organizations_list")).data[0];
    return {
      user: created.data.user,
      token,
      action,
      org,
      recoveryCode: created.data.recoveryCode,
    };
  }
  return { store, call, account };
}

test("view/edit links enforce capability boundaries, never grant ownership, and revoke immediately", async () => {
  const f = fixture();
  try {
    const owner = await f.account();
    const other = await f.account();
    const doc = (
      await owner.action("documents_create", {
        orgId: owner.org.id,
        title: "Draft.md",
        source: "# First",
      })
    ).data;
    expect(
      (
        await f.call("documents", "POST", {
          orgId: owner.org.id,
          title: "No",
          source: "",
        })
      ).status,
    ).toBe(401);
    expect(
      (await other.action("documents_get", { documentId: doc.id })).status,
    ).toBe(404);
    const view = (await owner.action("shares_create", { documentId: doc.id }))
      .data;
    const edit = (
      await owner.action("shares_create", { documentId: doc.id, role: "edit" })
    ).data;
    const viewPath = "shared/" + view.url.split("/").at(-1);
    const editPath = "shared/" + edit.url.split("/").at(-1);
    expect((await f.call(viewPath)).data.canEdit).toBe(false);
    expect(
      (await f.call(viewPath, "GET", undefined, owner.token)).data.canEdit,
    ).toBe(true);
    expect(
      (
        await f.call(
          viewPath,
          "PATCH",
          {
            baseVersion: doc.currentVersion,
            source: "# Existing owner permission",
          },
          owner.token,
        )
      ).status,
    ).toBe(200);
    const reset = (await owner.action("documents_get", { documentId: doc.id }))
      .data;
    doc.currentVersion = reset.currentVersion;

    expect(
      (
        await f.call(viewPath, "PATCH", {
          baseVersion: doc.currentVersion,
          source: "Bad",
        })
      ).status,
    ).toBe(403);
    expect((await f.call(editPath)).data.canEdit).toBe(true);
    expect((await f.call(editPath, "DELETE")).status).toBe(405);
    expect(
      (
        await f.call(editPath, "PATCH", {
          baseVersion: doc.currentVersion,
          source: "Bad",
          ownerId: other.user.id,
        })
      ).status,
    ).toBe(403);
    const saved = await f.call(editPath, "PATCH", {
      baseVersion: doc.currentVersion,
      source: "# Shared edit",
    });
    expect(saved.status).toBe(200);
    expect(saved.data.version.author).toBe("Link editor");
    expect(saved.data.version.checksum).toBe(checksum("# Shared edit"));
    expect(saved.data.canManage).toBe(false);
    expect(
      (
        await f.call(editPath, "PATCH", {
          baseVersion: doc.currentVersion,
          source: "Stale",
        })
      ).status,
    ).toBe(409);
    expect(
      (await owner.action("versions_list", { documentId: doc.id })).data,
    ).toHaveLength(2);
    await owner.action("shares_revoke", {
      documentId: doc.id,
      shareId: edit.id,
    });
    expect((await f.call(editPath)).status).toBe(404);
    expect(
      (
        await f.call(editPath, "PATCH", {
          baseVersion: saved.data.currentVersion,
          source: "No",
        })
      ).status,
    ).toBe(404);
    const hashes = f.store.all<{ tokenHash: string }>(
      "SELECT tokenHash FROM shares",
    );
    expect(hashes[0]!.tokenHash).not.toBe(view.url.split("/").at(-1));
  } finally {
    f.store.close();
  }
});

test("named editors can save but only owners manage sharing, history, deletion, and ownership", async () => {
  const f = fixture();
  try {
    const owner = await f.account();
    const collaborator = await f.account();
    const doc = (
      await owner.action("documents_create", {
        orgId: owner.org.id,
        title: "Design.md",
        source: "# Design",
      })
    ).data;
    await owner.action("permissions_set", {
      documentId: doc.id,
      username: collaborator.user.username,
      role: "view",
    });
    expect(
      (await collaborator.action("documents_get", { documentId: doc.id }))
        .status,
    ).toBe(200);
    expect(
      (
        await collaborator.action("documents_update", {
          documentId: doc.id,
          baseVersion: doc.currentVersion,
          source: "View cannot edit",
        })
      ).status,
    ).toBe(403);
    await owner.action("permissions_set", {
      documentId: doc.id,
      username: collaborator.user.username,
      role: "edit",
    });
    const changed = await collaborator.action("documents_update", {
      documentId: doc.id,
      baseVersion: doc.currentVersion,
      source: "Editor can edit",
    });
    expect(changed.status).toBe(200);
    for (const operation of [
      "documents_delete",
      "versions_list",
      "shares_list",
      "shares_create",
      "permissions_list",
      "documents_transfer",
    ])
      expect(
        (
          await collaborator.action(operation, {
            documentId: doc.id,
            username: collaborator.user.username,
          })
        ).status,
      ).toBe(403);
    expect(
      (
        await collaborator.action("documents_update", {
          documentId: doc.id,
          baseVersion: changed.data.currentVersion,
          access: "edit",
        })
      ).status,
    ).toBe(403);
    await owner.action("permissions_remove", {
      documentId: doc.id,
      userId: collaborator.user.id,
    });
    expect(
      (await collaborator.action("documents_get", { documentId: doc.id }))
        .status,
    ).toBe(404);
    await owner.action("documents_transfer", {
      documentId: doc.id,
      username: collaborator.user.username,
    });
    expect(
      (await collaborator.action("documents_delete", { documentId: doc.id }))
        .status,
    ).toBe(200);
  } finally {
    f.store.close();
  }
});

test("organization/team membership controls inherited access without taking file ownership", async () => {
  const f = fixture();
  try {
    const owner = await f.account();
    const member = await f.account();
    const outsider = await f.account();
    const team = (
      await owner.action("teams_create", {
        orgId: owner.org.id,
        name: "Writers",
      })
    ).data;
    const invite = (
      await owner.action("invitations_create", {
        orgId: owner.org.id,
        teamId: team.id,
      })
    ).data;
    const token = invite.url.split("invite=")[1];
    expect((await member.action("invitations_accept", { token })).status).toBe(
      200,
    );
    expect(
      (await outsider.action("invitations_accept", { token })).status,
    ).toBe(404);
    const doc = (
      await owner.action("documents_create", {
        orgId: owner.org.id,
        title: "Team.md",
        source: "# Team",
        teamId: team.id,
        access: "view",
      })
    ).data;
    expect(
      (await member.action("documents_get", { documentId: doc.id })).status,
    ).toBe(200);
    expect(
      (await outsider.action("documents_get", { documentId: doc.id })).status,
    ).toBe(404);
    expect(
      (await member.action("teams_create", { orgId: owner.org.id, name: "No" }))
        .status,
    ).toBe(403);
    const memberDoc = (
      await member.action("documents_create", {
        orgId: owner.org.id,
        title: "Mine.md",
        source: "# Private",
      })
    ).data;
    expect(memberDoc.ownerId).toBe(member.user.id);
    expect(
      (await owner.action("documents_get", { documentId: memberDoc.id }))
        .status,
    ).toBe(404);
    const updated = (
      await owner.action("documents_update", {
        documentId: doc.id,
        baseVersion: doc.currentVersion,
        access: "edit",
      })
    ).data;
    expect(
      (
        await member.action("documents_update", {
          documentId: doc.id,
          baseVersion: updated.currentVersion,
          source: "# Team update",
        })
      ).status,
    ).toBe(200);
    expect(
      (await member.action("documents_delete", { documentId: doc.id })).status,
    ).toBe(403);
    await owner.action("team_members_remove", {
      teamId: team.id,
      userId: member.user.id,
    });
    expect(
      (await member.action("documents_get", { documentId: doc.id })).status,
    ).toBe(404);
    expect(
      (
        await owner.action("members_remove", {
          orgId: owner.org.id,
          userId: owner.user.id,
        })
      ).status,
    ).toBe(409);
    const foreign = (
      await outsider.action("teams_create", {
        orgId: outsider.org.id,
        name: "Foreign",
      })
    ).data;
    expect(
      (
        await owner.action("documents_create", {
          orgId: owner.org.id,
          title: "Wrong",
          source: "",
          teamId: foreign.id,
        })
      ).status,
    ).toBe(400);
  } finally {
    f.store.close();
  }
});

test("pinned versions stay immutable, restore adds history, and deletion invalidates links", async () => {
  const f = fixture();
  try {
    const owner = await f.account();
    const doc = (
      await owner.action("documents_create", {
        orgId: owner.org.id,
        title: "Version.md",
        source: "# One",
      })
    ).data;
    const pin = (
      await owner.action("shares_create", {
        documentId: doc.id,
        versionId: doc.currentVersion,
      })
    ).data;
    expect(
      (
        await owner.action("shares_create", {
          documentId: doc.id,
          versionId: doc.currentVersion,
          role: "edit",
        })
      ).status,
    ).toBe(400);
    const next = (
      await owner.action("documents_update", {
        documentId: doc.id,
        baseVersion: doc.currentVersion,
        source: "# Two",
      })
    ).data;
    expect(
      (await f.call("shared/" + pin.url.split("/").at(-1))).data.version.source,
    ).toBe("# One");
    const restored = (
      await owner.action("versions_restore", {
        documentId: doc.id,
        versionId: doc.currentVersion,
        baseVersion: next.currentVersion,
      })
    ).data;
    expect(restored.currentVersion).not.toBe(doc.currentVersion);
    expect(restored.version.source).toBe("# One");
    expect(
      (await owner.action("versions_list", { documentId: doc.id })).data,
    ).toHaveLength(3);
    await owner.action("documents_delete", { documentId: doc.id });
    expect((await f.call("shared/" + pin.url.split("/").at(-1))).status).toBe(
      404,
    );
    expect(f.store.all("SELECT * FROM versions")).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

test("the one-time super-admin claim is secret gated and grants access across all owners", async () => {
  const before = process.env.READM3_ADMIN_BOOTSTRAP_SECRET;
  process.env.READM3_ADMIN_BOOTSTRAP_SECRET = "test-admin-" + id();
  const f = fixture();
  try {
    const first = await f.account();
    const admin = await f.account();
    const doc = (
      await first.action("documents_create", {
        orgId: first.org.id,
        title: "Private.md",
        source: "# Private",
      })
    ).data;
    expect((await admin.action("admin_users")).status).toBe(403);
    expect((await admin.action("admin_claim", { token: "wrong" })).status).toBe(
      403,
    );
    expect(
      (
        await admin.action("admin_claim", {
          token: process.env.READM3_ADMIN_BOOTSTRAP_SECRET,
        })
      ).data.admin,
    ).toBe(1);
    expect(
      (
        await first.action("admin_claim", {
          token: process.env.READM3_ADMIN_BOOTSTRAP_SECRET,
        })
      ).status,
    ).toBe(409);
    expect((await admin.action("admin_users")).data).toHaveLength(2);
    expect(
      (await admin.action("documents_get", { documentId: doc.id })).data
        .canManage,
    ).toBe(true);
    expect(
      (
        await admin.action("documents_update", {
          documentId: doc.id,
          baseVersion: doc.currentVersion,
          source: "# Moderated",
        })
      ).status,
    ).toBe(200);
    expect(
      (await admin.action("documents_delete", { documentId: doc.id })).status,
    ).toBe(200);
  } finally {
    f.store.close();
    if (before === undefined) delete process.env.READM3_ADMIN_BOOTSTRAP_SECRET;
    else process.env.READM3_ADMIN_BOOTSTRAP_SECRET = before;
  }
});

test("sessions and personal tokens revoke, recovery rotates secrets, and cross-origin writes fail", async () => {
  const f = fixture();
  try {
    const user = await f.account();
    const apiToken = (await user.action("tokens_create", { label: "test" }))
      .data;
    expect(
      (await f.call("me", "GET", undefined, apiToken.token)).data.user.id,
    ).toBe(user.user.id);
    expect(
      (
        await f.call(
          "actions",
          "POST",
          { operation: "account_me" },
          apiToken.token,
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    await user.action("tokens_revoke", { tokenId: apiToken.id });
    expect(
      (
        await f.call(
          "actions",
          "POST",
          { operation: "account_me" },
          apiToken.token,
        )
      ).status,
    ).toBe(401);
    const recovery = await f.call("auth/recover", "POST", {
      username: user.user.username,
      recoveryCode: user.recoveryCode,
      password: "another long password",
    });
    expect(recovery.status).toBe(200);
    expect(recovery.data.recoveryCode).not.toBe(user.recoveryCode);
    expect((await user.action("account_me")).status).toBe(401);
    expect(
      (
        await f.call("auth/recover", "POST", {
          username: user.user.username,
          recoveryCode: user.recoveryCode,
          password: "another long password",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.call("auth/login", "POST", {
          username: user.user.username,
          password: "another long password",
        })
      ).status,
    ).toBe(200);
  } finally {
    f.store.close();
  }
});

test("documents, versions, users, and share permissions survive a database restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "readm3-durable-"));
  const path = join(dir, "database.sqlite");
  const f = fixture(path);
  try {
    const owner = await f.account();
    const doc = (
      await owner.action("documents_create", {
        orgId: owner.org.id,
        title: "Persistent.md",
        source: "# Survives",
      })
    ).data;
    const link = (await owner.action("shares_create", { documentId: doc.id }))
      .data;
    f.store.close();
    const reopened = fixture(path);
    try {
      const result = await reopened.call(
        "shared/" + link.url.split("/").at(-1),
      );
      expect(result.status).toBe(200);
      expect(result.data.version.source).toBe("# Survives");
      expect(
        (
          await reopened.call(
            "actions",
            "POST",
            { operation: "versions_list", args: { documentId: doc.id } },
            owner.token,
          )
        ).data,
      ).toHaveLength(1);
    } finally {
      reopened.store.close();
    }
  } finally {
    try {
      f.store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("document search and pagination apply permissions before slicing results", async () => {
  const f = fixture();
  try {
    const owner = await f.account();
    const other = await f.account();
    for (const [who, title] of [
      [owner, "Visible A.md"],
      [other, "Hidden.md"],
      [owner, "Visible B.md"],
      [owner, "Visible C.md"],
    ] as const) {
      expect(
        (
          await who.action("documents_create", {
            orgId: who.org.id,
            title,
            source: "",
          })
        ).status,
      ).toBe(200);
    }
    const first = (await owner.action("documents_list", { limit: 2 })).data;
    const second = (
      await owner.action("documents_list", { limit: 2, offset: 2 })
    ).data;
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((d) => d.id)).size).toBe(3);
    expect(
      [...first, ...second].every((d) => d.ownerId === owner.user.id),
    ).toBe(true);
    const found = await f.call(
      "documents?search=visible%20b&limit=1",
      "GET",
      undefined,
      owner.token,
    );
    expect(found.data[0].title).toBe("Visible B.md");
    expect(
      (await owner.action("documents_list", { search: "Hidden" })).data,
    ).toHaveLength(0);
    expect((await owner.action("documents_list", { limit: -1 })).status).toBe(
      400,
    );
  } finally {
    f.store.close();
  }
});
