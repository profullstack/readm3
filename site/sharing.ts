import {
  action,
  request,
  modal,
  outputLink,
  showError,
  type CloudDocument,
  type CloudUser,
} from "./cloud.ts";
import { escape } from "./html.ts";
export async function publish(
  title: string,
  source: string,
  onCreated: (doc: CloudDocument) => void,
) {
  const session = await request<{ user: CloudUser | null }>("me");
  if (!session.user) {
    const box = modal("Share your Markdown");
    box.body.innerHTML =
      '<p>Sign in to save a document online, invite editors, and keep its history. Your local draft stays on this device.</p><a href="/admin?next=%2Fviewer">Sign in or create an account →</a>';
    return;
  }
  const orgs =
    await action<{ id: string; name: string }[]>("organizations_list");
  const box = modal("Save to your workspace");
  box.body.innerHTML = `<form class="cloud-form"><label>File name<input name="title" value="${escape(title)}" required maxlength="200"></label><label>Organization<select name="orgId">${orgs.map((o) => `<option value="${o.id}">${escape(o.name)}</option>`).join("")}</select></label><p class="permission-note">This uploads the current Markdown to your private workspace. You choose who can view or edit it next.</p><p class="error" role="alert"></p><button class="primary-action">Save online</button></form>`;
  const form = box.body.querySelector("form")!;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector("button")!;
    button.disabled = true;
    try {
      const data = new FormData(form);
      const doc = await action<CloudDocument>("documents_create", {
        title: data.get("title"),
        orgId: data.get("orgId"),
        source,
      });
      box.close();
      onCreated(doc);
      await sharing(doc, onCreated);
    } catch (error) {
      showError(form.querySelector<HTMLElement>(".error")!, error);
    } finally {
      button.disabled = false;
    }
  };
}
export async function sharing(
  doc: CloudDocument,
  onUpdated: (doc: CloudDocument) => void,
) {
  const [links, people, teams] = await Promise.all([
    action<
      { id: string; label: string; role: string; versionId: string | null }[]
    >("shares_list", { documentId: doc.id }),
    action<{ userId: string; username: string; role: string }[]>(
      "permissions_list",
      { documentId: doc.id },
    ),
    action<{ id: string; name: string }[]>("teams_list", {
      orgId: doc.orgId,
    }).catch(() => []),
  ]);
  const box = modal(`Share ${doc.title}`);
  box.body.innerHTML = `<p class="permission-note">Viewers can read. Editors can save new versions. Only you and the super admin can change permissions or delete the file.</p><form id="link-form" class="cloud-form"><label>Anyone with the link<select name="role"><option value="view">Can view</option><option value="edit">Can edit</option></select></label><label>Version<select name="version"><option value="">Latest version (follows future saves)</option><option value="${doc.version.id}">This version only (view only)</option></select></label><button class="primary-action">Create share link</button></form><div id="new-link"></div><div id="existing-links"></div><h3>People</h3><form id="person-form" class="cloud-form"><label>Email or username<input name="username" required placeholder="name@example.com"></label><label>Permission<select name="role"><option value="view">Can view</option><option value="edit">Can edit</option></select></label><button>Add collaborator</button></form><div id="existing-people"></div><h3>Organization and team access</h3><form id="group-form" class="cloud-form"><label>Group<select name="teamId"><option value="">Whole organization</option>${teams.map((t) => `<option value="${t.id}"${doc.teamId === t.id ? " selected" : ""}>${escape(t.name)}</option>`).join("")}</select></label><label>Permission<select name="access">${["private", "view", "edit"].map((v) => `<option value="${v}"${doc.access === v ? " selected" : ""}>${v === "private" ? "No group access" : v === "view" ? "Can view" : "Can edit"}</option>`).join("")}</select></label><button>Update group access</button></form><h3>Ownership</h3><form id="transfer-form" class="cloud-form"><label>New owner’s email or username<input name="username" required></label><button class="danger-action">Transfer ownership</button></form><p class="error" role="alert"></p>`;
  const error = box.body.querySelector<HTMLElement>(".error")!;
  function bind(selector: string, fn: (data: FormData) => Promise<void>) {
    const form = box.body.querySelector<HTMLFormElement>(selector)!;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const button = form.querySelector("button")!;
      button.disabled = true;
      error.textContent = "";
      try {
        await fn(new FormData(form));
      } catch (cause) {
        showError(error, cause);
      } finally {
        button.disabled = false;
      }
    };
  }
  const refresh = async () => {
    box.close();
    await sharing(doc, onUpdated);
  };
  function smallAction(
    label: string,
    fn: () => Promise<unknown>,
    parent: HTMLElement,
  ) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = async () => {
      try {
        await fn();
        await refresh();
      } catch (cause) {
        showError(error, cause);
      }
    };
    parent.append(b);
  }
  bind("#link-form", async (data) => {
    const link = await action<{ url: string; id: string }>("shares_create", {
      documentId: doc.id,
      role: data.get("role"),
      versionId: data.get("version") || undefined,
    });
    const target = box.body.querySelector<HTMLElement>("#new-link")!;
    target.replaceChildren();
    const note = document.createElement("p");
    note.textContent =
      "Copy this link now. For privacy, its secret is not stored on the server.";
    target.append(note);
    outputLink(target, link.url);
    smallAction(
      "Revoke this link",
      () => action("shares_revoke", { documentId: doc.id, shareId: link.id }),
      target,
    );
  });
  for (const link of links) {
    const row = document.createElement("p");
    row.textContent = `${link.label} · ${link.role}${link.versionId ? " · pinned version" : ""} `;
    smallAction(
      "Revoke",
      () => action("shares_revoke", { documentId: doc.id, shareId: link.id }),
      row,
    );
    box.body.querySelector("#existing-links")!.append(row);
  }
  bind("#person-form", async (data) => {
    await action("permissions_set", {
      documentId: doc.id,
      username: data.get("username"),
      role: data.get("role"),
    });
    await refresh();
  });
  for (const person of people) {
    const row = document.createElement("p");
    row.textContent = `@${person.username} · can ${person.role} `;
    smallAction(
      "Remove",
      () =>
        action("permissions_remove", {
          documentId: doc.id,
          userId: person.userId,
        }),
      row,
    );
    box.body.querySelector("#existing-people")!.append(row);
  }
  bind("#group-form", async (data) => {
    doc = await action<CloudDocument>("documents_update", {
      documentId: doc.id,
      baseVersion: doc.currentVersion,
      access: data.get("access"),
      teamId: data.get("teamId") || null,
    });
    onUpdated(doc);
    await refresh();
  });
  bind("#transfer-form", async (data) => {
    if (
      !confirm(
        "Transfer ownership? The new owner will manage this file and your owner permissions will be removed.",
      )
    )
      return;
    await action("documents_transfer", {
      documentId: doc.id,
      username: data.get("username"),
    });
    box.close();
    location.reload();
  });
}
export async function history(
  doc: CloudDocument,
  onRestored: (doc: CloudDocument) => void,
) {
  const versions = await action<
    {
      id: string;
      title: string;
      checksum: string;
      createdAt: string;
      author: string;
    }[]
  >("versions_list", { documentId: doc.id });
  const box = modal("Version history");
  box.body.innerHTML =
    '<p class="permission-note">Each save creates an immutable version. Restoring keeps the history and creates a new current version.</p><p class="error" role="alert"></p>';
  for (const version of versions) {
    const row = document.createElement("div");
    row.className = "history-item";
    row.innerHTML = `<strong>${escape(new Date(version.createdAt).toLocaleString())}${version.id === doc.currentVersion ? " · Current" : ""}</strong><span>${escape(version.author)} · ${escape(version.title)}</span><code>${version.id} · SHA-256 ${version.checksum}</code><div class="cloud-actions"></div>`;
    const actions = row.querySelector(".cloud-actions")!;
    const preview = document.createElement("button");
    preview.textContent = "View source";
    preview.onclick = async () => {
      try {
        const snapshot = await action<CloudDocument>("versions_get", {
          documentId: doc.id,
          versionId: version.id,
        });
        const detail = modal("Saved Markdown");
        const pre = document.createElement("pre");
        pre.textContent = snapshot.version.source;
        detail.body.append(pre);
      } catch (error) {
        showError(box.body.querySelector<HTMLElement>(".error")!, error);
      }
    };
    actions.append(preview);
    if (version.id !== doc.currentVersion) {
      const restore = document.createElement("button");
      restore.textContent = "Restore";
      restore.onclick = async () => {
        try {
          if (!confirm("Restore this version as a new save?")) return;
          const restored = await action<CloudDocument>("versions_restore", {
            documentId: doc.id,
            versionId: version.id,
            baseVersion: doc.currentVersion,
          });
          onRestored(restored);
          box.close();
        } catch (error) {
          showError(box.body.querySelector<HTMLElement>(".error")!, error);
        }
      };
      actions.append(restore);
    }
    box.body.append(row);
  }
}
