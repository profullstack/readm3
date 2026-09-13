import {
  action,
  request,
  modal,
  outputLink,
  showError,
  type CloudUser,
  type CloudDocument,
} from "./cloud.ts";
import { escape } from "./html.ts";
type Org = { id: string; name: string; role: string };
type Team = { id: string; name: string };
type Member = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};
const content = document.getElementById("admin-content")!;
const status = document.getElementById("admin-status")!;
let user: CloudUser;
let organizations: Org[] = [];
let selected = "";
let tab = "documents";
let refreshGeneration = 0;
const tabLabel = (value: string) =>
  value === "api tokens"
    ? "API tokens"
    : value[0].toUpperCase() + value.slice(1);
const tabId = (value: string) => `tab-${value.replaceAll(" ", "-")}`;
const icons = {
  organization:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-4h6v4M8 7h2m4 0h2M8 11h2m4 0h2"/>',
  team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
};
const icon = (name: keyof typeof icons) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
function actionMenu(label: string, items = "") {
  return `<details class="action-menu" name="workspace-actions"><summary aria-label="${escape(label)}" title="${escape(label)}">${icon("more")}</summary><div class="action-menu-items">${items}</div></details>`;
}
document.addEventListener("click", (event) => {
  const target = event.target as Element;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    ".action-menu[open]",
  )) {
    if (!menu.contains(target) || target.closest(".action-menu-items button"))
      menu.open = false;
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    ".action-menu[open]",
  )) {
    menu.open = false;
    menu.querySelector("summary")!.focus();
    event.preventDefault();
  }
});
const pending = new URLSearchParams(location.hash.slice(1));
if (pending.has("invite") || pending.has("claim")) {
  sessionStorage.setItem("readm3:pending", pending.toString());
  history.replaceState(null, "", location.pathname + location.search);
}
const run = (fn: () => Promise<unknown>) => {
  status.textContent = "";
  void fn().catch((error) => showError(status, error));
};
function button(
  label: string,
  fn: () => Promise<unknown>,
  parent: HTMLElement,
  cls = "",
) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = cls;
  b.onclick = () => run(fn);
  parent.append(b);
  return b;
}
function formDialog(
  title: string,
  fields: string,
  onSubmit: (data: FormData, box: ReturnType<typeof modal>) => Promise<void>,
  submitLabel = "Save",
) {
  const box = modal(title);
  box.body.innerHTML = `<form class="cloud-form">${fields}<p class="error" role="alert"></p><div class="form-actions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary-action">${escape(submitLabel)}</button></div></form>`;
  box.body.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick =
    box.close;
  box.body.querySelector<HTMLInputElement>("input")?.focus();
  const form = box.body.querySelector("form")!;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>(
      'button[type="submit"],button.primary-action',
    )!;
    submit.disabled = true;
    try {
      await onSubmit(new FormData(form), box);
    } catch (error) {
      showError(form.querySelector(".error")!, error);
    } finally {
      submit.disabled = false;
    }
  };
  return box;
}
const input = (name: string, label: string, value = "", type = "text") =>
  `<label>${escape(label)}<input name="${name}" type="${type}" value="${escape(value)}" required maxlength="200"></label>`;
function auth() {
  content.innerHTML = `<section class="auth-card"><p class="eyebrow">A home for your Markdown</p><h1>Your next draft starts here.</h1><p>Sign in with your email to create private documents, invite collaborators, and keep every version.</p><a class="primary-action" href="/account?next=${encodeURIComponent(location.pathname + location.search)}">Continue with email →</a></section>`;
}
async function signedIn() {
  const stored = new URLSearchParams(
    sessionStorage.getItem("readm3:pending") || "",
  );
  if (stored.has("claim")) {
    user = await action<CloudUser>("admin_claim", {
      token: stored.get("claim"),
    });
    sessionStorage.removeItem("readm3:pending");
  }
  if (stored.has("invite")) {
    const accepted = await action<{ orgId: string }>("invitations_accept", {
      token: stored.get("invite"),
    });
    selected = accepted.orgId;
    sessionStorage.removeItem("readm3:pending");
  }
  const next = new URLSearchParams(location.search).get("next");
  if (next && /^\/viewer(?:\?|$)/.test(next)) {
    location.href = next;
    return;
  }
  document.getElementById("account-label")!.textContent =
    `${user.displayName}${user.admin ? " · Super admin" : ""}`;
  document.getElementById("logout")!.hidden = false;
  document.getElementById("logout")!.onclick = () =>
    run(async () => {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok)
        throw new Error("Could not sign out. Please try again.");
      location.href = "/admin";
    });
  await refresh();
}
async function refresh(focus?: string) {
  const generation = ++refreshGeneration;
  const list = await action<Org[]>("organizations_list");
  if (generation !== refreshGeneration) return;
  organizations = list;
  if (!organizations.some((o) => o.id === selected))
    selected = organizations[0]?.id ?? "";
  const organization = organizations.find((o) => o.id === selected);
  const orgOwner = organization?.role === "owner";
  const tabs = [
    "documents",
    ...(orgOwner ? ["members"] : []),
    "teams",
    "api tokens",
    ...(user.admin ? ["users"] : []),
  ];
  if (!tabs.includes(tab)) tab = "documents";
  content.innerHTML = `
    <section class="admin-hero">
      <div><h1>Your workspace</h1><p>Write, share, and keep every version.</p></div>
      <button id="create-document" class="${tab === "documents" ? "primary-action" : ""}"${selected ? "" : " disabled"}>+ New document</button>
    </section>
    <div class="org-switch">
      <span class="org-icon">${icon("organization")}</span>
      <div class="org-field"><label for="org-select">Organization</label><select id="org-select"${organizations.length ? "" : " disabled"}>
        ${organizations.length ? organizations.map((o) => `<option value="${o.id}"${o.id === selected ? " selected" : ""}>${escape(o.name)}</option>`).join("") : "<option>No organization yet</option>"}
      </select></div>
      ${organization ? `<span class="badge org-role">${user.admin ? "Super admin" : orgOwner ? "Owner" : "Member"}</span>` : ""}
      ${actionMenu("Organization options", `<button id="create-org">+ New organization</button>${orgOwner ? '<button id="rename-org">Rename organization</button><button id="delete-org" class="danger-action">Delete organization</button>' : ""}`)}
    </div>
    <nav class="admin-tabs" aria-label="Workspace sections">
      ${tabs.map((t) => `<button id="${tabId(t)}" data-tab="${t}" aria-controls="tab-content"${tab === t ? ' aria-current="page"' : ""}>${tabLabel(t)}</button>`).join("")}
    </nav>
    <section id="tab-content" aria-labelledby="${tabId(tab)}" aria-busy="true"><p class="loading-state">Loading ${tabLabel(tab).toLowerCase()}…</p></section>`;
  content.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab!;
        run(() => refresh(`#${tabId(tab)}`));
      }),
  );
  document.getElementById("org-select")!.onchange = (e) => {
    selected = (e.target as HTMLSelectElement).value;
    run(() => refresh("#org-select"));
  };
  document.getElementById("create-org")!.onclick = () =>
    formDialog(
      "New organization",
      input("name", "Organization name"),
      async (data, box) => {
        const org = await action<Org>("organizations_create", {
          name: data.get("name"),
        });
        selected = org.id;
        box.close();
        await refresh();
      },
    );
  document.getElementById("rename-org")?.addEventListener("click", () =>
    formDialog(
      "Rename organization",
      input("name", "Organization name", organization!.name),
      async (data, box) => {
        await action("organizations_update", {
          orgId: selected,
          name: data.get("name"),
        });
        box.close();
        await refresh();
      },
    ),
  );
  document.getElementById("delete-org")?.addEventListener("click", () =>
    run(async () => {
      if (
        confirm(
          "Delete this empty organization and its memberships? Documents must be removed first.",
        )
      ) {
        await action("organizations_delete", { orgId: selected });
        await refresh();
      }
    }),
  );
  document.getElementById("create-document")!.onclick = () =>
    formDialog(
      "New Markdown document",
      input("title", "File name", "Untitled.md") +
        `<label for="new-markdown">Markdown</label><textarea id="new-markdown" name="source" aria-label="Markdown"># Untitled\n\n</textarea><p class="permission-note">Private to you until you choose who can view or edit.</p>`,
      async (data, box) => {
        const doc = await action<CloudDocument>("documents_create", {
          orgId: selected,
          title: data.get("title"),
          source: data.get("source"),
        });
        box.close();
        location.href = `/viewer?doc=${doc.id}&edit=1`;
      },
    );
  if (focus) content.querySelector<HTMLElement>(focus)?.focus();
  const panel = document.getElementById("tab-content")!;
  try {
    if (!selected && ["teams", "members"].includes(tab)) {
      panel.innerHTML =
        '<div class="empty-state"><h2>Create your first organization</h2><p>Give your documents and collaborators a place to work together.</p><button class="primary-action" id="first-org">+ New organization</button></div>';
      panel.querySelector<HTMLButtonElement>("#first-org")!.onclick = () =>
        document.getElementById("create-org")!.click();
    } else if (tab === "documents") await documents(panel);
    else if (tab === "members") await members(panel);
    else if (tab === "teams") await teams(panel, !!orgOwner);
    else if (tab === "api tokens") await tokens(panel);
    else if (tab === "users") await users(panel);
  } catch (error) {
    panel.innerHTML =
      '<div class="empty-state"><h2>This section couldn’t load</h2><p>Please try again.</p></div>';
    button("Try again", refresh, panel.querySelector(".empty-state")!);
    throw error;
  } finally {
    panel.setAttribute("aria-busy", "false");
  }
}
async function documents(panel: HTMLElement) {
  let offset = 0,
    query = "",
    generation = 0;
  const limit = 50;
  panel.innerHTML = `<div class="section-header"><div><h2>Documents</h2><p>${user.admin ? "All documents across all users. You have super admin access." : "All your documents and files shared with you."}</p></div></div><div class="toolbar"><input id="find-doc" type="search" placeholder="Find a document…" aria-label="Find a document"></div><div class="table-scroll"><table class="admin-table"><thead><tr><th>Document</th><th>Owner</th><th>Access</th><th>Updated</th><th aria-label="Actions"></th></tr></thead><tbody></tbody></table></div><div class="toolbar" id="document-pages"></div><div class="empty-state" hidden><h3>No documents here yet.</h3><p>Create a Markdown file or adjust your search.</p></div>`;
  const rows = panel.querySelector("tbody")!;
  async function render() {
    const current = ++generation;
    const docs = await action<CloudDocument[]>("documents_list", {
      search: query || undefined,
      offset,
      limit,
    });
    if (current !== generation) return;
    rows.replaceChildren();
    for (const doc of docs) {
      const row = document.createElement("tr");
      row.innerHTML = `<td><a href="/viewer?doc=${doc.id}">${escape(doc.title)}</a><span class="subtle">${escape(doc.id)}</span></td><td>${escape(doc.ownerDisplayName || doc.ownerUsername || "")}</td><td><span class="badge">${doc.canManage ? "Owner access" : doc.canEdit ? "Can edit" : "Can view"}</span></td><td>${escape(new Date(doc.updatedAt).toLocaleDateString())}</td><td></td>`;
      if (doc.canManage) {
        const controls = row.lastElementChild as HTMLElement;
        button(
          "Rename",
          async () => {
            formDialog(
              "Rename document",
              input("title", "File name", doc.title),
              async (data, box) => {
                await action("documents_update", {
                  documentId: doc.id,
                  baseVersion: doc.currentVersion,
                  title: data.get("title"),
                });
                box.close();
                await render();
              },
            );
          },
          controls,
        );
        button(
          "Delete",
          async () => {
            if (
              confirm(
                `Permanently delete ${doc.title}, all versions, and shared links?`,
              )
            ) {
              await action("documents_delete", { documentId: doc.id });
              await render();
            }
          },
          controls,
          "danger-action",
        );
      }
      rows.append(row);
    }
    panel.querySelector<HTMLElement>(".empty-state")!.hidden = docs.length > 0;
    panel.querySelector<HTMLElement>(".table-scroll")!.hidden =
      docs.length === 0;
    const pages = panel.querySelector<HTMLElement>("#document-pages")!;
    pages.replaceChildren();
    if (offset)
      button(
        "Previous documents",
        async () => {
          offset = Math.max(0, offset - limit);
          await render();
        },
        pages,
      );
    if (docs.length === limit)
      button(
        "More documents",
        async () => {
          offset += limit;
          await render();
        },
        pages,
      );
  }
  let timer: ReturnType<typeof setTimeout>;
  panel.querySelector<HTMLInputElement>("#find-doc")!.oninput = (e) => {
    query = (e.target as HTMLInputElement).value;
    offset = 0;
    generation++;
    clearTimeout(timer);
    timer = setTimeout(() => run(render), 200);
  };
  await render();
}
async function members(panel: HTMLElement) {
  const [list, invites] = await Promise.all([
    action<Member[]>("members_list", { orgId: selected }),
    action<{ id: string; role: string; expiresAt: string }[]>(
      "invitations_list",
      { orgId: selected },
    ),
  ]);
  panel.innerHTML = `<div class="section-header"><div><h2>Members <span class="count-badge">${list.length}</span></h2><p>Manage who belongs to this organization and their role.</p></div><div id="invite-action"></div></div><div class="table-scroll"><table class="admin-table"><thead><tr><th>Person</th><th>Role</th><th aria-label="Actions"></th></tr></thead><tbody></tbody></table></div><h3 class="subsection-heading">Pending invitations</h3><div id="invitations">${invites.length ? "" : '<p class="permission-note">No pending invitations.</p>'}</div>`;
  button(
    "Invite someone",
    async () => {
      formDialog(
        "Invite to organization",
        '<label>Organization role<select name="role"><option value="member">Member</option><option value="owner">Organization owner</option></select></label><p class="permission-note">Copy the one-use invitation link. It expires after seven days.</p>',
        async (data, box) => {
          const invite = await action<{ url: string }>("invitations_create", {
            orgId: selected,
            role: data.get("role"),
          });
          box.body.replaceChildren();
          outputLink(box.body, invite.url);
          await refresh();
        },
      );
    },
    panel.querySelector("#invite-action")!,
    "primary-action",
  );
  const rows = panel.querySelector("tbody")!;
  for (const member of list) {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${escape(member.displayName)}<span class="subtle">@${escape(member.username)}</span></td><td>${member.role}</td><td></td>`;
    const controls = row.lastElementChild as HTMLElement;
    button(
      member.role === "owner" ? "Make member" : "Make org owner",
      async () => {
        await action("members_update", {
          orgId: selected,
          userId: member.id,
          role: member.role === "owner" ? "member" : "owner",
        });
        await refresh();
      },
      controls,
    );
    button(
      "Remove",
      async () => {
        if (confirm(`Remove ${member.displayName} from this organization?`)) {
          await action("members_remove", {
            orgId: selected,
            userId: member.id,
          });
          await refresh();
        }
      },
      controls,
    );
    rows.append(row);
  }
  for (const invite of invites) {
    const row = document.createElement("p");
    row.textContent = `${invite.role} invitation · expires ${new Date(invite.expiresAt).toLocaleDateString()} `;
    button(
      "Revoke",
      async () => {
        await action("invitations_revoke", { invitationId: invite.id });
        await refresh();
      },
      row,
    );
    panel.querySelector("#invitations")!.append(row);
  }
}
async function teamMembers(team: Team, owner: boolean) {
  const orgId = selected;
  const box = modal(`${team.name} members`);
  const render = async () => {
    const [people, orgMembers] = await Promise.all([
      action<Member[]>("team_members_list", { teamId: team.id }),
      owner ? action<Member[]>("members_list", { orgId }) : Promise.resolve([]),
    ]);
    if (!box.dialog.open) return;
    box.body.innerHTML = `<p class="permission-note">Team members can access documents shared with this team.</p><div class="team-member-list"></div><p class="error" role="alert"></p>`;
    const list = box.body.querySelector<HTMLElement>(".team-member-list")!;
    const change = async (
      operation: string,
      userId: string,
      control: HTMLButtonElement,
    ) => {
      control.disabled = true;
      box.body.querySelector(".error")!.textContent = "";
      try {
        await action(operation, { teamId: team.id, userId });
        await render();
        box.body
          .querySelector<HTMLElement>("select, .team-member-row button")
          ?.focus();
      } catch (error) {
        showError(box.body.querySelector(".error")!, error);
      } finally {
        control.disabled = false;
      }
    };
    if (!people.length)
      list.innerHTML = '<p class="member-empty">No members yet.</p>';
    for (const person of people) {
      const row = document.createElement("div");
      row.className = "team-member-row";
      row.innerHTML = `<span>${escape(person.displayName)}<span class="subtle">@${escape(person.username)}</span></span>`;
      if (owner) {
        const remove = button(
          "Remove",
          async () => change("team_members_remove", person.id, remove),
          row,
          "danger-action",
        );
        remove.setAttribute(
          "aria-label",
          `Remove ${person.displayName} from team`,
        );
      }
      list.append(row);
    }
    if (owner) {
      const available = orgMembers.filter(
        (person) => !people.some((member) => member.id === person.id),
      );
      if (available.length) {
        const form = document.createElement("form");
        form.className = "team-member-form";
        form.innerHTML = `<label for="team-member-select">Add an organization member</label><div><select id="team-member-select" aria-label="Organization member">${available.map((person) => `<option value="${escape(person.id)}">${escape(person.displayName)}</option>`).join("")}</select><button class="primary-action" type="submit">Add to team</button></div>`;
        form.onsubmit = (event) => {
          event.preventDefault();
          void change(
            "team_members_add",
            form.querySelector("select")!.value,
            form.querySelector("button")!,
          );
        };
        box.body.append(form);
      } else {
        const note = document.createElement("p");
        note.className = "permission-note";
        note.textContent =
          "Everyone in this organization is on this team. Invite more people from the Members section.";
        box.body.append(note);
      }
    }
  };
  box.body.innerHTML = '<p class="loading-state">Loading members…</p>';
  try {
    await render();
  } catch (error) {
    showError(box.body, error);
  }
}
async function teams(panel: HTMLElement, owner: boolean) {
  const list = await action<Team[]>("teams_list", { orgId: selected });
  panel.innerHTML = `
    <div class="section-header">
      <div><h2>Teams <span class="count-badge">${list.length}</span></h2><p>Share documents with the right people, one team at a time.</p></div>
      <div id="team-actions"></div>
    </div>
    ${list.length ? '<div class="team-toolbar"><label class="search-field"><span>Find a team</span><input id="find-team" type="search" placeholder="Search teams…"></label></div>' : ""}
    <div id="team-list" class="team-list"></div>
    <div class="empty-state" id="team-empty" hidden></div>
    <aside class="team-help"><span class="help-mark" aria-hidden="true">i</span><p><strong>Share a document with a team</strong>Open a document’s Share menu, choose a team under Group, and set view or edit access.</p></aside>`;
  if (owner)
    button(
      "+ New team",
      async () => {
        formDialog(
          "Create team",
          input("name", "Team name") +
            '<p class="permission-note">Add people from your organization after creating the team.</p>',
          async (data, box) => {
            await action("teams_create", {
              orgId: selected,
              name: data.get("name"),
            });
            box.close();
            await refresh("#find-team");
          },
          "Create team",
        );
      },
      panel.querySelector("#team-actions")!,
      "primary-action",
    );
  const rows = panel.querySelector<HTMLElement>("#team-list")!;
  const empty = panel.querySelector<HTMLElement>("#team-empty")!;
  function render(query = "") {
    rows.replaceChildren();
    const filtered = list.filter((team) =>
      team.name.toLowerCase().includes(query.trim().toLowerCase()),
    );
    rows.hidden = !filtered.length;
    empty.hidden = !!filtered.length;
    if (!filtered.length) {
      empty.innerHTML = list.length
        ? "<h3>No teams match your search</h3><p>Try another name or clear your search.</p>"
        : `<span class="empty-icon">${icon("team")}</span><h3>Bring your people together</h3><p>${owner ? "Create a team for a project, department, or group of collaborators." : "An organization owner can create a team and add members."}</p>`;
      if (list.length)
        button(
          "Clear search",
          async () => {
            const search = panel.querySelector<HTMLInputElement>("#find-team")!;
            search.value = "";
            render();
            search.focus();
          },
          empty,
        );
    }
    for (const team of filtered) {
      const row = document.createElement("section");
      row.className = "team-row";
      row.setAttribute("aria-label", team.name);
      row.innerHTML = `<div class="team-identity"><span class="team-icon">${icon("team")}</span><h3>${escape(team.name)}</h3></div><div class="team-row-actions"></div>`;
      const group = row.querySelector<HTMLElement>(".team-row-actions")!;
      button("Members", () => teamMembers(team, owner), group);
      if (owner) {
        group.insertAdjacentHTML(
          "beforeend",
          actionMenu(`${team.name} options`),
        );
        const menu = group.querySelector<HTMLElement>(".action-menu-items")!;
        button(
          "Rename team",
          async () => {
            formDialog(
              "Rename team",
              input("name", "Team name", team.name),
              async (data, box) => {
                await action("teams_update", {
                  teamId: team.id,
                  name: data.get("name"),
                });
                box.close();
                await refresh();
              },
              "Save changes",
            );
          },
          menu,
        );
        button(
          "Delete team",
          async () => {
            if (confirm(`Delete team ${team.name}?`)) {
              await action("teams_delete", { teamId: team.id });
              await refresh();
            }
          },
          menu,
          "danger-action",
        );
      }
      rows.append(row);
    }
  }
  render();
  panel
    .querySelector<HTMLInputElement>("#find-team")
    ?.addEventListener("input", (event) =>
      render((event.target as HTMLInputElement).value),
    );
}
async function tokens(panel: HTMLElement) {
  const list =
    await action<{ id: string; label: string; expiresAt: string }[]>(
      "tokens_list",
    );
  panel.innerHTML =
    '<div class="section-header"><div><h2>API tokens</h2><p>Connect your CLI, API, and MCP tools to your account.</p></div><div id="token-actions"></div></div><p class="permission-note">Personal tokens use your account’s permissions. They expire after 90 days and can be revoked here.</p><div id="token-list"></div><pre>readm3 login --token-stdin\nreadm3 share README.md --org YOUR_ORG_ID\nreadm3 mcp</pre>';
  button(
    "Create API token",
    async () => {
      formDialog(
        "Create personal token",
        input("label", "Token label", "CLI and MCP"),
        async (data, box) => {
          const token = await action<{ token: string }>("tokens_create", {
            label: data.get("label"),
          });
          box.body.innerHTML =
            "<p>Copy this token now. It will not be shown again.</p>";
          outputLink(box.body, token.token, "Copy token");
          await refresh();
        },
      );
    },
    panel.querySelector("#token-actions")!,
    "primary-action",
  );
  for (const token of list) {
    const row = document.createElement("p");
    row.textContent = `${token.label} · expires ${new Date(token.expiresAt).toLocaleDateString()} `;
    button(
      "Revoke",
      async () => {
        await action("tokens_revoke", { tokenId: token.id });
        await refresh();
      },
      row,
    );
    panel.querySelector("#token-list")!.append(row);
  }
}
async function users(panel: HTMLElement) {
  const people = await action<CloudUser[]>("admin_users");
  panel.innerHTML = `<h2>All users</h2><p class="permission-note">Your super-admin access can open, edit, transfer, share, and delete every document from the Documents tab.</p><div class="table-scroll"><table class="admin-table"><thead><tr><th>User</th><th>Username</th><th>Role</th></tr></thead><tbody>${people.map((p) => `<tr><td>${escape(p.displayName)}</td><td>${escape(p.username)}</td><td>${p.admin ? "Super admin" : "User"}</td></tr>`).join("")}</tbody></table></div>`;
}
run(async () => {
  const session = await request<{ user: CloudUser | null }>("me");
  if (session.user) {
    user = session.user;
    await signedIn();
  } else auth();
});
