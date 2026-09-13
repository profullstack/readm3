import { test, expect, type BrowserContext, type Page } from "@playwright/test";
const suffix = () => Math.random().toString(36).slice(2, 10);
async function register(context: BrowserContext, name = "writer_" + suffix()) {
  const origin = "http://127.0.0.1:4318";
  const email = name + "@example.com";
  const sent = await context.request.post("/api/auth/email", {
    headers: { origin },
    data: { email },
  });
  expect(sent.ok(), await sent.text()).toBe(true);
  const mail = await (
    await context.request.get(`http://127.0.0.1:4319/test/mail?email=${email}`)
  ).json();
  const token = new URLSearchParams(new URL(mail[0].url).hash.slice(1)).get(
    "verify",
  );
  const response = await context.request.post("/api/auth/verify", {
    headers: { origin },
    data: { token },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).user;
}
async function action(
  context: BrowserContext,
  operation: string,
  args: Record<string, unknown> = {},
) {
  const response = await context.request.post("/api/v1/actions", {
    headers: {
      origin: new URL(
        context.pages()[0]?.url().startsWith("http")
          ? context.pages()[0]!.url()
          : process.env.READM3_TEST_URL || "http://127.0.0.1:4318",
      ).origin,
    },
    data: { operation, args },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function create(context: BrowserContext) {
  await register(context);
  const orgs = await action(context, "organizations_list");
  return action(context, "documents_create", {
    orgId: orgs[0].id,
    title: "Project plan.md",
    source: "# Project plan\n\nFirst draft.",
  });
}

test("verified email signup returns to the workspace and saves a private document", async ({
  page,
  request,
}) => {
  await page.goto("/admin");
  await page.getByRole("link", { name: "Continue with email" }).click();
  const email = "writer_" + suffix() + "@example.com";
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox." }),
  ).toBeVisible();
  const mail = await (
    await request.get(`http://127.0.0.1:4319/test/mail?email=${email}`)
  ).json();
  await page.goto(mail[0].url);
  await page.getByRole("button", { name: "Verify email & sign in" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await page
    .getByRole("button", { name: "+ New document", exact: true })
    .click();
  await page.getByLabel("File name").fill("My draft.md");
  await page
    .getByLabel("Markdown", { exact: true })
    .fill("# My draft\n\nPrivate writing.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#editor")).toBeVisible();
  await page.locator("#editor").fill("# My draft\n\nAn improved draft.");
  await page.locator("#cloud-save").click();
  await expect(page.locator("#save-status")).toHaveText("Version saved online");
  await page.locator("#read-mode").click();
  await expect(page.locator("#document-content")).toContainText(
    "An improved draft.",
  );
});

test("share dialog creates default read-only links and explicit edit links; editors save but cannot administer", async ({
  page,
  context,
  browser,
}) => {
  const doc = await create(context);
  await page.goto(`/viewer?doc=${doc.id}`);
  await expect(page.locator("#reader")).toBeVisible();
  await expect(page.locator("#editor")).not.toBeVisible();
  await page.locator("#share").click();
  await page
    .getByRole("button", { name: "Create share link", exact: true })
    .click();
  const viewUrl = await page
    .getByRole("textbox", { name: "Copy link", exact: true })
    .inputValue();
  const guest = await browser.newContext({
    baseURL: process.env.READM3_TEST_URL || "http://127.0.0.1:4318",
  });
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto(viewUrl);
    await expect(guestPage.locator("#document-content")).toContainText(
      "First draft.",
    );
    await expect(guestPage.locator("#edit-mode")).toBeDisabled();
    await expect(guestPage.locator("#share")).not.toBeVisible();
    await page.getByLabel("Anyone with the link").selectOption("edit");
    await page
      .getByRole("button", { name: "Create share link", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Copy link", exact: true }),
    ).not.toHaveValue(viewUrl);
    const editUrl = await page
      .getByRole("textbox", { name: "Copy link", exact: true })
      .inputValue();
    await guestPage.goto(editUrl);
    await expect(guestPage.locator("#reader")).toBeVisible();
    await guestPage.locator("#edit-mode").click();
    await guestPage
      .locator("#editor")
      .fill("# Project plan\n\nEdited by a collaborator.");
    await guestPage.locator("#cloud-save").click();
    await expect(guestPage.locator("#save-status")).toHaveText(
      "Version saved online",
    );
    await expect(guestPage.locator("#history")).not.toBeVisible();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await page.reload();
    await expect(page.locator("#document-content")).toContainText(
      "Edited by a collaborator.",
    );
    await page.locator("#history").click();
    await expect(page.locator(".history-item")).toHaveCount(2);
    await expect(page.getByText("Link editor", { exact: false })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.locator("#document-content")).toContainText(
      "First draft.",
    );
  } finally {
    await guest.close();
  }
});

test("concurrent editor saves reject stale versions and preserve the unsaved text", async ({
  page,
  context,
}) => {
  const doc = await create(context);
  await page.goto(`/viewer?doc=${doc.id}`);
  await page.locator("#edit-mode").click();
  await page.locator("#editor").fill("# My still-open draft");
  await action(context, "documents_update", {
    documentId: doc.id,
    baseVersion: doc.currentVersion,
    source: "# Someone else's saved version",
  });
  await page.locator("#cloud-save").click();
  await expect(page.locator("#notice")).toContainText(
    "changed since you opened",
  );
  await expect(page.locator("#editor")).toHaveValue("# My still-open draft");
  await expect(page.locator("#save-status")).toContainText("Not saved");
});

test("revoked links stop working and cloud documents never enter the offline workspace", async ({
  page,
  context,
  browser,
}) => {
  const doc = await create(context);
  const share = await action(context, "shares_create", {
    documentId: doc.id,
    role: "view",
  });
  const guest = await browser.newContext({
    baseURL: process.env.READM3_TEST_URL || "http://127.0.0.1:4318",
  });
  try {
    const guestPage = await guest.newPage();
    await guestPage.goto("/viewer");
    await expect(guestPage.locator("#save-status")).toHaveText(
      "Saved on this device",
    );
    await guestPage.goto(share.url);
    await expect(guestPage.locator("#document-content")).toContainText(
      "First draft.",
    );
    const saved = await guestPage.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("readm3", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = reject;
      });
      return await new Promise<string>((resolve) => {
        const request = db
          .transaction("workspace")
          .objectStore("workspace")
          .get("current");
        request.onsuccess = () => resolve(JSON.stringify(request.result));
      });
    });
    expect(saved).not.toContain("First draft.");
    await action(context, "shares_revoke", {
      documentId: doc.id,
      shareId: share.id,
    });
    await guestPage.reload();
    await expect(guestPage.locator("#document-name")).toHaveText(
      "Document unavailable",
    );
    await expect(guestPage.locator("#document-content")).toContainText(
      "revoked",
    );
  } finally {
    await guest.close();
  }
});

test("super-admin setup grants the account administration of another user's private file", async ({
  page,
  context,
  browser,
}) => {
  test.skip(
    !!process.env.READM3_TEST_URL,
    "The live super-admin claim must never be consumed by a test.",
  );
  const other = await browser.newContext({ baseURL: "http://127.0.0.1:4318" });
  try {
    const doc = await create(other);
    await register(context, "superadmin_" + suffix());
    await page.goto("/admin#claim=browser-test-admin-secret");
    await expect(page.locator("#account-label")).toContainText("Super admin");
    await expect(
      page.getByRole("link", { name: "Project plan.md" }).first(),
    ).toBeVisible();
    await page.goto(`/viewer?doc=${doc.id}`);
    await expect(page.locator("#edit-mode")).toBeEnabled();
    await expect(page.locator("#share")).toBeVisible();
    await page.locator("#edit-mode").click();
    await page.locator("#editor").fill("# Super-admin correction");
    await page.locator("#cloud-save").click();
    await expect(page.locator("#save-status")).toHaveText(
      "Version saved online",
    );
  } finally {
    await other.close();
  }
});

test("homepage sells editing and launches a new local draft", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Great docs get shared",
  );
  await page.getByRole("link", { name: "Start writing", exact: false }).click();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#document-name")).toHaveText("Untitled.md");
});

test("workspace menus keep team creation, renaming, search, and confirmed deletion reachable", async ({
  page,
  context,
}) => {
  await register(context);
  const [org] = await action(context, "organizations_list");
  await action(context, "organizations_update", {
    orgId: org.id,
    name: "Profullstack, Inc.",
  });
  await page.goto("/admin");
  const orgOptions = page.getByLabel("Organization options", { exact: true });
  await orgOptions.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Delete organization", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(orgOptions).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Delete organization", exact: true }),
  ).not.toBeVisible();
  await orgOptions.click();
  await page.getByRole("heading", { name: "Your workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Delete organization", exact: true }),
  ).not.toBeVisible();

  await page.getByRole("button", { name: "Teams", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Bring your people together" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Teams", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "+ New team", exact: true }).click();
  await expect(page.getByLabel("Team name", { exact: true })).toBeFocused();
  await page.getByLabel("Team name", { exact: true }).fill("contractors");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "contractors", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Find a team", { exact: true }).fill("missing");
  await expect(
    page.getByRole("heading", { name: "No teams match your search" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByRole("heading", { name: "contractors", exact: true }),
  ).toBeVisible();
  await page.getByLabel("contractors options", { exact: true }).click();
  await page.getByRole("button", { name: "Rename team", exact: true }).click();
  await page.getByLabel("Team name", { exact: true }).fill("Partners");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Partners", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Partners options", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Delete team", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Partners", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Partners options", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete team", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Bring your people together" }),
  ).toBeVisible();
  expect(await action(context, "teams_list", { orgId: org.id })).toEqual([]);
});

test("team members update in place and organization members get read-only controls", async ({
  page,
  context,
  browser,
}) => {
  const owner = await register(context);
  const [org] = await action(context, "organizations_list");
  const team = await action(context, "teams_create", {
    orgId: org.id,
    name: "contractors",
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Teams", exact: true }).click();
  await page
    .locator(".team-row")
    .getByRole("button", { name: "Members", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "contractors members",
    exact: true,
  });
  await expect(dialog).toContainText("No members yet.");
  await dialog
    .getByRole("button", { name: "Add to team", exact: true })
    .click();
  await expect(dialog.locator(".team-member-row")).toContainText(
    owner.displayName,
  );
  await expect(dialog).toContainText(
    "Everyone in this organization is on this team.",
  );
  await expect(
    dialog.getByRole("button", { name: "Add to team", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", {
      name: `Remove ${owner.displayName} from team`,
      exact: true,
    })
    .click();
  await expect(dialog).toContainText("No members yet.");
  await dialog
    .getByRole("button", { name: "Add to team", exact: true })
    .click();
  await expect(dialog.locator(".team-member-row")).toHaveCount(1);
  expect(
    (await action(context, "team_members_list", { teamId: team.id })).map(
      (person: { id: string }) => person.id,
    ),
  ).toEqual([owner.id]);
  await dialog.getByRole("button", { name: "Close dialog" }).click();

  const memberContext = await browser.newContext({
    baseURL: "http://127.0.0.1:4318",
  });
  try {
    await register(memberContext);
    const invite = await action(context, "invitations_create", {
      orgId: org.id,
      role: "member",
    });
    const token = new URLSearchParams(new URL(invite.url).hash.slice(1)).get(
      "invite",
    );
    await action(memberContext, "invitations_accept", { token });
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/admin");
    await memberPage
      .getByRole("button", { name: "Members", exact: true })
      .click();
    await memberPage
      .getByLabel("Organization", { exact: true })
      .selectOption(org.id);
    await expect(memberPage.locator('[data-tab="documents"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    await memberPage
      .getByRole("button", { name: "Teams", exact: true })
      .click();
    await expect(
      memberPage.getByRole("button", { name: "+ New team", exact: true }),
    ).toHaveCount(0);
    await expect(
      memberPage.getByLabel("contractors options", { exact: true }),
    ).toHaveCount(0);
    await memberPage
      .locator(".team-row")
      .getByRole("button", { name: "Members", exact: true })
      .click();
    const readOnly = memberPage.getByRole("dialog", {
      name: "contractors members",
      exact: true,
    });
    await expect(readOnly.locator(".team-member-row")).toContainText(
      owner.displayName,
    );
    await expect(
      readOnly.getByRole("button", { name: /Remove|Add to team/ }),
    ).toHaveCount(0);
    await expect(memberPage.locator("#admin-status")).toBeEmpty();
  } finally {
    await memberContext.close();
  }
});

test("workspace remains scrollable on narrow screens with long team and organization names", async ({
  page,
  context,
}) => {
  await register(context);
  const [org] = await action(context, "organizations_list");
  await action(context, "organizations_update", {
    orgId: org.id,
    name: "Profullstack, Inc. — a very long organization name",
  });
  for (let index = 0; index < 8; index++)
    await action(context, "teams_create", {
      orgId: org.id,
      name: `Team ${index} — ${"collaborators".repeat(8)}`,
    });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Teams", exact: true }).click();
  await expect(page.locator(".team-row")).toHaveCount(8);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const last = page.locator(".team-row").last();
  await last.scrollIntoViewIfNeeded();
  await last.locator("summary").click();
  await expect(
    last.getByRole("button", { name: "Rename team", exact: true }),
  ).toBeInViewport();
  const bounds = await last.locator(".action-menu-items").boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  await page.keyboard.press("Escape");
  await last.getByRole("button", { name: "Members", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("No members yet.");
  expect(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "API tokens", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "API tokens", exact: true }),
  ).toBeVisible();
});
