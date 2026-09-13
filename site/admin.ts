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
) {
  const box = modal(title);
  box.body.innerHTML = `<form class="cloud-form">${fields}<p class="error" role="alert"></p><button class="primary-action">Save</button></form>`;
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
  content.innerHTML =
    '<section class="auth-card"><p class="eyebrow">A home for your Markdown</p><h1>Your next draft starts here.</h1><p>Sign in with your email to create private documents, invite collaborators, and keep every version.</p><a class="primary-action" href="/account?next=%2Fadmin">Continue with email →</a></section>';
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
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      location.href = "/admin";
    });
  await refresh();
}
async function refresh() {
  organizations = await action<Org[]>("organizations_list");
  if (!organizations.some((o) => o.id === selected))
    selected = organizations[0]?.id ?? "";
  const organization = organizations.find((o) => o.id === selected);
  const orgOwner = organization?.role === "owner";
  content.innerHTML = `<section class="admin-hero"><div><p class="eyebrow">${user.admin ? "Super administrator" : "Your workspace"}</p><h1>Make room for your next draft.</h1><p>Write in Markdown. Invite a second pair of eyes. Keep every version.</p></div><button id="create-document" class="primary-action">+ New document</button></section><div class="org-switch"><label>Organization <select id="org-select">${organizations.map((o) => `<option value="${o.id}"${o.id === selected ? " selected" : ""}>${escape(o.name)}</option>`).join("")}</select></label><button id="create-org">+ New organization</button>${orgOwner ? '<button id="rename-org">Rename</button><button id="delete-org">Delete organization</button>' : ""}</div><nav class="admin-tabs" aria-label="Workspace sections">${["documents", ...(orgOwner ? ["members", "teams"] : ["teams"]), "api tokens", ...(user.admin ? ["users"] : [])].map((t) => `<button data-tab="${t}"${tab === t ? ' aria-current="page"' : ""}>${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</nav><div id="tab-content"></div>`;
  content.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab!;
        run(refresh);
      }),
  );
  document.getElementById("org-select")!.onchange = (e) => {
    selected = (e.target as HTMLSelectElement).value;
    run(refresh);
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
  const panel = document.getElementById("tab-content")!;
  if (tab === "documents") await documents(panel);
  else if (tab === "members") await members(panel);
  else if (tab === "teams") await teams(panel, !!orgOwner);
  else if (tab === "api tokens") await tokens(panel);
  else if (tab === "users") await users(panel);
}
async function documents(panel: HTMLElement) {
  let offset = 0,
    query = "",
    generation = 0;
  const limit = 50;
  panel.innerHTML = `<div class="toolbar"><p class="permission-note">${user.admin ? "Super admin: all documents across all users." : "All your documents and files shared with you. Owners manage permissions and deletion."}</p><input id="find-doc" type="search" placeholder="Find a document…" aria-label="Find a document"></div><div class="table-scroll"><table class="admin-table"><thead><tr><th>Document</th><th>Owner</th><th>Access</th><th>Updated</th><th></th></tr></thead><tbody></tbody></table></div><div class="toolbar" id="document-pages"></div><div class="empty-state" hidden><h2>No documents here yet.</h2><p>Create a Markdown file or adjust your search.</p></div>`;
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
  panel.innerHTML =
    '<div class="toolbar"><p class="permission-note">Organization owners manage membership. Document ownership stays with its creator.</p><div id="invite-action"></div></div><div class="table-scroll"><table class="admin-table"><thead><tr><th>Person</th><th>Role</th><th></th></tr></thead><tbody></tbody></table></div><h2>Pending invitations</h2><div id="invitations"></div>';
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
async function teams(panel: HTMLElement, owner: boolean) {
  const list = await action<Team[]>("teams_list", { orgId: selected });
  panel.innerHTML =
    '<div class="toolbar"><p class="permission-note">Teams let you share documents with a smaller group.</p><div id="team-actions"></div></div><div id="team-list"></div>';
  if (owner)
    button(
      "+ New team",
      async () => {
        formDialog(
          "Create team",
          input("name", "Team name"),
          async (data, box) => {
            await action("teams_create", {
              orgId: selected,
              name: data.get("name"),
            });
            box.close();
            await refresh();
          },
        );
      },
      panel.querySelector("#team-actions")!,
    );
  for (const team of list) {
    const row = document.createElement("section");
    row.className = "history-item";
    const title = document.createElement("h3");
    title.textContent = team.name;
    row.append(title);
    const group = document.createElement("div");
    group.className = "cloud-actions";
    row.append(group);
    button(
      "Members",
      async () => {
        const [people, orgMembers] = await Promise.all([
          action<Member[]>("team_members_list", { teamId: team.id }),
          action<Member[]>("members_list", { orgId: selected }),
        ]);
        const box = modal(`${team.name} members`);
        for (const person of people) {
          const line = document.createElement("p");
          line.textContent = person.displayName + " ";
          if (owner)
            button(
              "Remove",
              async () => {
                await action("team_members_remove", {
                  teamId: team.id,
                  userId: person.id,
                });
                box.close();
                await refresh();
              },
              line,
            );
          box.body.append(line);
        }
        if (owner) {
          const select = document.createElement("select");
          select.setAttribute("aria-label", "Organization member");
          for (const person of orgMembers.filter(
            (p) => !people.some((m) => m.id === p.id),
          )) {
            const option = document.createElement("option");
            option.value = person.id;
            option.textContent = person.displayName;
            select.append(option);
          }
          box.body.append(select);
          button(
            "Add to team",
            async () => {
              if (select.value) {
                await action("team_members_add", {
                  teamId: team.id,
                  userId: select.value,
                });
                box.close();
                await refresh();
              }
            },
            box.body,
          );
        }
      },
      group,
    );
    if (owner) {
      button(
        "Rename",
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
          );
        },
        group,
      );
      button(
        "Delete",
        async () => {
          if (confirm(`Delete team ${team.name}?`)) {
            await action("teams_delete", { teamId: team.id });
            await refresh();
          }
        },
        group,
        "danger-action",
      );
    }
    panel.querySelector("#team-list")!.append(row);
  }
}
async function tokens(panel: HTMLElement) {
  const list =
    await action<{ id: string; label: string; expiresAt: string }[]>(
      "tokens_list",
    );
  panel.innerHTML =
    '<h2>Connect your tools.</h2><p class="permission-note">Personal tokens give the CLI, API, and MCP your account’s permissions. They expire after 90 days and can be revoked here.</p><div id="token-actions"></div><div id="token-list"></div><pre>readm3 login --token-stdin\nreadm3 share README.md --org YOUR_ORG_ID\nreadm3 mcp</pre>';
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
