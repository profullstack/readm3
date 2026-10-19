import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { stat } from "node:fs/promises";
import { editorInput } from "./editor.ts";

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
const PASSPHRASE = "correct horse battery staple";
async function openSync(page: Page) {
  await page.locator("#sync-workspace").click();
  await expect(page.getByRole("dialog", { name: "Sync your workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sync now", exact: true })).toBeVisible();
}
/** The first signed-in device is asked to choose the sync passphrase. */
async function setPassphrase(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Encrypt your synced files" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Sync passphrase").fill(PASSPHRASE);
  await dialog.getByLabel("Type it again").fill(PASSPHRASE);
  await dialog.getByRole("button", { name: "Encrypt and sync" }).click();
  await expect(dialog).toBeHidden();
}
async function unlock(page: Page, passphrase = PASSPHRASE) {
  const dialog = page.getByRole("dialog", { name: "Unlock your synced files" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Sync passphrase").fill(passphrase);
  await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
}
async function sealedSnapshot(page: Page) {
  const response = await page.request.get("/api/v1/settings");
  if (!response.ok()) return null;
  const body = await response.json();
  return Object.keys(body.snapshot.files).join() === "sealed.json" ? body : null;
}

test("a reader can register through the account UI and sync end to end encrypted", async ({ page }) => {
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
  await setPassphrase(page);
  await page.locator("#files-input").setInputFiles({ name: "Private.md", mimeType: "text/markdown", buffer: Buffer.from("# my secret notes\n") });
  await expect.poll(() => sealedSnapshot(page), { timeout: 20_000 }).not.toBeNull();
  const raw = JSON.stringify(await sealedSnapshot(page));
  expect(raw).not.toContain("Private");
  expect(raw).not.toContain("secret");
  await openSync(page);
  await expect(page.getByRole("dialog", { name: "Sync your workspace" })).toContainText("Signed in as");
  await expect(page.getByRole("dialog", { name: "Sync your workspace" })).toContainText("End-to-end encrypted");
  const manifest = await (await page.request.get("/viewer.webmanifest")).json();
  expect(new URL("/admin", page.url()).pathname.startsWith(manifest.scope)).toBe(true);
  expect(await page.locator('link[href*="__"]').count()).toBe(0);
});

test("two devices sync files and settings automatically through the encrypted copy", async ({ page, browser }) => {
  await register(page.context(), username());
  await page.goto("/viewer");
  await setPassphrase(page);
  await page.locator("#theme").selectOption("nord");
  await page.locator("#flavor").selectOption("reddit");
  await page.locator("#files-input").setInputFiles({ name: "Synced.md", mimeType: "text/markdown", buffer: Buffer.from("# Across devices\n\nHello 😺\n") });
  await expect.poll(() => sealedSnapshot(page), { timeout: 20_000 }).not.toBeNull();
  await expect(page.locator("#sync-note")).toContainText("Synced", { timeout: 20_000 });

  const second = await browser.newContext();
  try {
    const origin = new URL(page.url()).origin;
    await second.addCookies(await page.context().cookies());
    const other = await second.newPage();
    await other.goto(`${origin}/viewer`);
    await unlock(other, "not the passphrase");
    await expect(other.getByRole("dialog", { name: "Unlock your synced files" })).toContainText("does not open");
    await unlock(other);
    await expect(other.locator('.file-row[data-path="Synced.md"]')).toBeVisible({ timeout: 20_000 });
    await expect(other.locator("#theme")).toHaveValue("nord");
    await expect(other.locator("#flavor")).toHaveValue("reddit");
    await other.locator('.file-row[data-path="Synced.md"]').click();
    await other.locator("#edit-mode").click();
    await editorInput(other).fill("# Edited on second device\n");
    await expect(other.locator("#sync-note")).toContainText("Synced", { timeout: 20_000 });

    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.locator('.file-row[data-path="Synced.md"]').click();
    await expect(page.locator("#document-content")).toContainText("Edited on second device", { timeout: 20_000 });
    await openSync(page);
    await page.getByRole("button", { name: "Local backups", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Local sync backups" })).toBeVisible();
  } finally { await second.close(); }
});

test("sync requires sign-in and account snapshots are not served from the offline cache", async ({ page, context }) => {
  await page.goto("/viewer");
  await page.locator("#sync-workspace").click();
  await expect(page.getByRole("link", { name: "Sign in or create an account" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await register(context, username());
  await page.reload();
  await setPassphrase(page);
  await page.locator("#files-input").setInputFiles({ name: "Offline.md", mimeType: "text/markdown", buffer: Buffer.from("# offline\n") });
  await expect.poll(() => sealedSnapshot(page), { timeout: 20_000 }).not.toBeNull();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  const cached = await page.evaluate(async () => {
    try { return (await fetch("/api/v1/settings")).ok; } catch { return false; }
  });
  expect(cached).toBe(false);
  await context.setOffline(false);
});

test("a signed-in account opens a file over 4 MB read-only and syncs it as an encrypted stored file", async ({ page, context }) => {
  await register(context, username());
  await page.goto("/viewer");
  await setPassphrase(page);
  const line = "large log line with a marker\n";
  const big = Buffer.from(line.repeat(Math.ceil(9 * 1024 * 1024 / line.length)));
  await page.locator("#files-input").setInputFiles({ name: "server.log", mimeType: "text/plain", buffer: big });
  await expect(page.locator("#document-name")).toHaveText("server.log");
  await expect(page.locator("#code-content")).toContainText("too large to edit here");
  await expect(page.locator("#code-content .large-preview")).toContainText("large log line with a marker");
  await expect(page.locator("#edit-mode")).toBeDisabled();
  await expect(page.locator("#document-info")).toContainText("read-only");
  await expect.poll(async () => {
    const account = await (await page.request.get("/api/v1/blobs")).json();
    return account.blobs.filter((blob: { complete: boolean }) => blob.complete).map((blob: { size: number }) => blob.size);
  }, { timeout: 20_000 }).toEqual([big.length]);
  await expect.poll(async () => JSON.stringify(await sealedSnapshot(page)), { timeout: 20_000 }).toContain("sealed.json");
  expect(JSON.stringify(await sealedSnapshot(page))).not.toContain("server.log");
  const downloading = page.waitForEvent("download");
  await page.locator("#download").click();
  expect((await stat((await (await downloading).path())!)).size).toBe(big.length);
});

test("signed out, a file over 4 MB asks for a free account", async ({ page }) => {
  await page.goto("/viewer");
  await page.locator("#files-input").setInputFiles({ name: "huge.md", mimeType: "text/markdown", buffer: Buffer.alloc(4 * 1024 * 1024 + 1, "a") });
  await expect(page.locator("#notice")).toContainText("Sign in (free) for files up to 5 GB");
});
