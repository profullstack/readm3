import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const origin = process.env.READM3_TEST_URL || `http://127.0.0.1:${process.env.READM3_TEST_PORT || 4318}`;
const mailOrigin = `http://127.0.0.1:${Number(new URL(origin).port) + 1}`;
async function register(context: BrowserContext, name: string) {
  const email = `${name}@example.com`;
  const sent = await context.request.post(`${origin}/api/auth/email`, { headers: { origin }, data: { email } });
  expect(sent.ok()).toBe(true);
  const mail = await (await context.request.get(`${mailOrigin}/test/mail?email=${encodeURIComponent(email)}`)).json();
  const token = new URLSearchParams(new URL(mail[0].url).hash.slice(1)).get("verify");
  const verified = await context.request.post(`${origin}/api/auth/verify`, { headers: { origin }, data: { token } });
  expect(verified.ok()).toBe(true);
  return (await verified.json()).user;
}
const username = () => `sync-${crypto.randomUUID().slice(0, 12)}`;
async function openSync(page: Page) {
  await page.locator("#sync-workspace").click();
  await expect(page.getByRole("dialog", { name: "Sync your workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save to account", exact: true })).toBeVisible();
}

test("a reader can register through the account UI and return to sync in the PWA", async ({ page }) => {
  await page.goto("/viewer");
  await page.locator("#sync-workspace").click();
  await page.getByRole("link", { name: "Sign in or create an account" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  const name = username();
  const email = `${name}@example.com`;
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox." })).toBeVisible();
  const mail = await (await page.request.get(`${mailOrigin}/test/mail?email=${encodeURIComponent(email)}`)).json();
  await page.goto(mail[0].url);
  await page.getByRole("button", { name: "Verify email & sign in" }).click();
  await expect(page).toHaveURL(/\/viewer$/);
  await openSync(page);
  await expect(page.getByRole("dialog")).toContainText("Signed in as");
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Saved revision 1");
  const manifest = await (await page.request.get("/viewer.webmanifest")).json();
  expect(new URL("/admin", page.url()).pathname.startsWith(manifest.scope)).toBe(true);
  expect(await page.locator('link[href*="__"]').count()).toBe(0);
});

test("PWA and API exchange snapshots, preserve local conflicts, and keep recoverable backups", async ({ page, browser }) => {
  const name = username();
  await register(page.context(), name);
  await page.goto("/viewer");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.locator("#theme").selectOption("nord");
  await page.locator("#flavor").selectOption("reddit");
  await page.locator("#files-input").setInputFiles({ name: "Synced.md", mimeType: "text/markdown", buffer: Buffer.from("# Across devices\n\nHello 😺\n") });
  await openSync(page);
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Saved revision 1");
  const response = await page.request.get("/api/v1/settings");
  const first = await response.json();
  expect(Object.keys(first.snapshot.files).sort()).toEqual(["settings.json", "workspace.json"]);
  expect(JSON.parse(first.snapshot.files["workspace.json"].content).documents.some((doc: { source: string }) => doc.source.includes("Hello 😺"))).toBe(true);
  expect(JSON.parse(first.snapshot.files["settings.json"].content)).toEqual({ theme: "nord", flavor: "reddit" });

  const second = await browser.newContext();
  try {
    const origin = new URL(page.url()).origin;
    await second.addCookies(await page.context().cookies());
    const other = await second.newPage();
    await other.goto(`${origin}/viewer`);
    await expect(other.locator("#save-status")).toHaveText("Saved on this device");
    await openSync(other);
    await other.getByRole("button", { name: "Load from account", exact: true }).click();
    await expect(other.getByRole("dialog")).toContainText("This browser has local changes");
    await other.getByRole("checkbox", { name: /Replace conflicting changes/ }).check();
    await other.getByRole("button", { name: "Load from account", exact: true }).click();
    await expect(other.getByRole("dialog")).toContainText("Loaded revision 1");
    await expect(other.locator("#document-name")).toHaveText("Synced.md");
    await expect(other.locator("#theme")).toHaveValue("nord");
    await expect(other.locator("#flavor")).toHaveValue("reddit");
    await other.getByRole("button", { name: "Local backups", exact: true }).click();
    await expect(other.getByRole("button", { name: /Download backup/ })).toBeVisible();
    await other.getByRole("dialog", { name: "Local sync backups" }).getByRole("button", { name: "Close dialog" }).click();
    await other.getByRole("checkbox", { name: /Replace conflicting changes/ }).uncheck();
    await other.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
    await other.locator("#edit-mode").click();
    await other.locator("#editor").fill("# Edited on second device\n");
    await openSync(other);
    await other.getByRole("button", { name: "Save to account", exact: true }).click();
    await expect(other.getByRole("dialog")).toContainText("Saved revision 2");

    await page.getByRole("button", { name: "Save to account", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("another machine saved first");
    await page.getByRole("button", { name: "Load from account", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Loaded revision 2");
    await expect(page.locator("#document-content")).toContainText("Edited on second device");
  } finally { await second.close(); }
});

test("sync requires sign-in and account snapshots are not served from the offline cache", async ({ page, context }) => {
  await page.goto("/viewer");
  await page.locator("#sync-workspace").click();
  await expect(page.getByRole("link", { name: "Sign in or create an account" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await register(context, username());
  await openSync(page);
  await page.getByRole("button", { name: "Save to account", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Saved revision 1");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  const cached = await page.evaluate(async () => {
    try { return (await fetch("/api/v1/settings")).ok; } catch { return false; }
  });
  expect(cached).toBe(false);
  await context.setOffline(false);
});
