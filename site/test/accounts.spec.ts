import { expect, test } from "@playwright/test";

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
