import { expect, test } from "@playwright/test";
import { DOCX } from "../../server/test/zip.ts";

test("verified signup, profile, persistence, sign-out, and return sign-in", async ({ page, request }) => {
  const email = `browser-${Date.now()}@example.com`;
  await page.goto("/account");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox." })).toBeVisible();
  await expect(page.locator("#resend")).toBeDisabled();
  expect((await (await page.request.get("/api/auth/session")).json()).user).toBeNull();
  const mail = await (await request.get(`http://127.0.0.1:4322/test/mail?email=${email}`)).json();
  await page.goto(mail[0].url);
  await expect(page.getByRole("heading", { name: "You’re one click away." })).toBeVisible();
  expect(page.url()).not.toContain("#");
  expect((await (await page.request.get("/api/auth/session")).json()).user).toBeNull();
  await page.getByRole("button", { name: "Verify email & sign in" }).click();
  await expect(page.getByText("Email verified", { exact: true })).toBeVisible();
  await page.getByLabel("Display name").fill("Alex Reader");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status")).toContainText("Your name has been saved.");
  await page.reload();
  await expect(page.getByLabel("Display name")).toHaveValue("Alex Reader");
  expect(await page.evaluate(() => document.cookie)).not.toContain("readm3_session");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Make yourself at home." })).toBeVisible();
  await page.goto(mail[0].url);
  await expect(page.getByRole("alert")).toContainText("invalid or has expired");
});

test("mobile account page fits the screen and exposes navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/account");
  await expect(page.getByLabel("Email address")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: "test-results/account-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "test-results/account-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Open reader", exact: false }).first().click();
  await expect(page).toHaveURL(/\/viewer$/);
  await expect(page.getByRole("link", { name: "Account", exact: true })).toBeVisible();
});

test("email errors are visible and verification is protected against embedding and caching", async ({ page, request }) => {
  const response = await request.get("/account");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await page.route("**/api/auth/email", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "We couldn't send your sign-in email. Please try again in a minute." }) }));
  await page.goto("/account");
  await page.getByLabel("Email address").fill("failure@example.com");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("alert")).toContainText("couldn't send");
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeEnabled();
  await expect(page.locator("#check-email")).not.toBeVisible();
});

test("Sign in with CoinPay creates an account whose only sign-in is CoinPay", async ({ page }) => {
  await page.goto("/account");
  await page.getByRole("link", { name: "Sign in with CoinPay" }).click();
  await expect(page.getByText("CoinPay account", { exact: true })).toBeVisible();
  await expect(page.locator("#account-email")).toHaveText("Signed in with CoinPay");
  await expect(page.locator("#coinpay-linked")).toContainText("CoinPay linked (coin@example.com).");
  await expect(page.locator("#coinpay-linked")).toContainText("cannot be unlinked");
  await expect(page.getByRole("button", { name: "Unlink CoinPay" })).toBeHidden();
  await expect(page.getByLabel("Display name")).toHaveValue("Coin Reader");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in with CoinPay" })).toBeVisible();
});

test("readm3.com/talk: a signed-in reader asks AI about a file, then follows up", async ({ page }) => {
  await page.goto("/account");
  await page.getByRole("link", { name: "Sign in with CoinPay" }).click();
  await expect(page.locator("#account-email")).toHaveText("Signed in with CoinPay");
  await page.goto("/talk");
  await expect(page).toHaveURL(/\/viewer$/);
  const passphrase = page.getByRole("dialog", { name: "Encrypt your synced files" });
  await expect(passphrase).toBeVisible();
  await passphrase.getByRole("button", { name: "Close dialog" }).click();
  const dialog = page.locator(".ask-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#ask-scope option")).toContainText(["This file · Welcome.md", "Whole workspace"]);
  await dialog.locator("#ask-scope").selectOption({ label: "Whole workspace" });
  await expect(dialog.locator(".ask-log")).toContainText("3 files will be read");
  await dialog.getByLabel("Your question").fill("What is readm3?");
  await dialog.getByLabel("Your question").press("Enter");
  await expect(dialog.locator(".summary-text")).toContainText("=== examples/demo.md ===");
  await expect(dialog.locator(".history-account")).toContainText(/Free · \d+ of 10 free questions left today/);
  await dialog.getByLabel("Your question").fill("And the demo?");
  await dialog.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(dialog.locator(".summary-text")).toHaveCount(2);
  await expect(dialog.locator(".summary-text").nth(1)).toContainText("Test summary of");
  // Every answer can be read aloud, like a summary.
  await dialog.getByRole("button", { name: "Listen to this answer" }).first().click();
  await expect(dialog.locator(".summary-listen audio").first()).toHaveAttribute("src", /^blob:/);
});

test("Summarize: a signed-in reader gets a free AI summary of the open document, and pressing again costs nothing", async ({ page }) => {
  await page.goto("/account");
  await page.getByRole("link", { name: "Sign in with CoinPay" }).click();
  await expect(page.locator("#account-email")).toHaveText("Signed in with CoinPay");
  await page.goto("/viewer");
  // First sign-in on a device asks for a sync passphrase; this test does not sync.
  const passphrase = page.getByRole("dialog", { name: "Encrypt your synced files" });
  await expect(passphrase).toBeVisible();
  await passphrase.getByRole("button", { name: "Close dialog" }).click();
  await page.locator("#summarize").click();
  const dialog = page.locator(".summary-dialog");
  await expect(dialog.locator(".summary-text")).toContainText("Test summary of");
  await expect(dialog.locator(".history-account")).toContainText("Free · 9 of 10 free summaries left this week");
  // Listen reads it aloud: an audio player takes the button's place.
  await dialog.getByRole("button", { name: "Listen to this summary" }).click();
  await expect(dialog.locator(".summary-listen audio")).toHaveAttribute("src", /^blob:/);
  await dialog.getByRole("button", { name: "Close summary" }).click();
  await page.locator("#summarize").click();
  await expect(page.locator(".summary-dialog .history-account")).toContainText("Saved summary, no charge · 9 of 10");
  // The server keeps it too: after a reload the same document is still free and not summarized again.
  await page.locator(".summary-dialog").getByRole("button", { name: "Close summary" }).click();
  await page.reload();
  await passphrase.getByRole("button", { name: "Close dialog" }).click();
  await page.locator("#summarize").click();
  await expect(page.locator(".summary-dialog .history-account")).toContainText("Saved summary, no charge · 9 of 10");
  await expect(page.locator(".summary-dialog").getByRole("button", { name: "Listen to this summary" })).toHaveText("Listen");
  await page.locator(".summary-dialog").getByRole("button", { name: "Close summary" }).click();

  // Every kind of file summarizes: a PDF goes as itself, an SVG is redrawn as PNG, a Word file as its text.
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>`);
  await page.locator("#files-input").setInputFiles([
    { name: "spec.pdf", mimeType: "application/pdf", buffer: pdf },
    { name: "logo.svg", mimeType: "image/svg+xml", buffer: svg },
    { name: "plan.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(DOCX) },
  ]);
  const summarizeFile = async (name: string, expected: string, left: number) => {
    await page.locator(`#file-list button[title="${name}"]`).click();
    await expect(page.locator("#summarize")).toBeVisible();
    await page.locator("#summarize").click();
    await expect(dialog.locator(".summary-text")).toContainText(expected);
    await expect(dialog.locator(".history-account")).toContainText(`Free · ${left} of 10`);
    await dialog.getByRole("button", { name: "Close summary" }).click();
  };
  await summarizeFile("spec.pdf", "an attached application/pdf", 8);
  await summarizeFile("logo.svg", "an attached image/png", 7);
  // The Word file shows a card (browsers cannot show it) with its own Summarize button.
  await page.locator('#file-list button[title="plan.docx"]').click();
  await expect(page.locator("#file-mark")).toHaveText("DOCX");
  await expect(page.locator("#media-content .media-card")).toContainText("Word document");
  await page.locator("#media-content").getByRole("button", { name: "Summarize with AI" }).click();
  await expect(dialog.locator(".summary-text")).toContainText("Budget: $4,200 & rising");
  await expect(dialog.locator(".history-account")).toContainText("Free · 6 of 10");
});
