import { test, expect } from "@playwright/test";

test("the paste page makes a paste from text, links to it, and opens one by link", async ({ page }) => {
  await page.goto("/paste");
  await expect(page.locator("h1")).toContainText("Paste anything");
  await expect(page.locator("nav a[href='/paste']")).toHaveText("Paste");
  await expect(page.locator("figure.code figcaption")).toHaveText(["CLI", "curl", "API", "MCP"]);
  await page.locator("#paste-source").fill('{"fleet":"vienna","live":true}');
  await expect(page.locator("#paste-meta")).toContainText("JSON");
  await page.locator("#paste-expires").selectOption("1d");
  await page.locator("#paste-submit").click();
  const result = page.locator("#paste-result");
  await expect(result).toBeVisible();
  await expect(result.locator("h2")).toHaveText("paste.json is pasted.");
  const link = await result.locator(".copy-value input").inputValue();
  expect(link).toMatch(/\/p\/[A-Za-z0-9_-]{43}$/);
  await expect(result.locator(".paste-curl")).toContainText(`curl ${link}/raw`);
  await expect(page.locator("#paste-form")).toBeHidden();
  // The reader side: paste a link (or a bare token) and land on the paste.
  await page.locator("#open-input").fill("not a link");
  await page.locator("#open-form button").click();
  await expect(page.locator("#open-error")).toContainText("not a paste link");
  await page.locator("#open-input").fill(link);
  await page.locator("#open-form button").click();
  await expect(page).toHaveURL(link);
  await expect(page.locator("#document-name")).toHaveText("paste.json");
  await expect(page.locator("#code-content .hljs-attr").first()).toBeVisible();
  await expect(page.locator("#new-paste")).toHaveAttribute("href", "/paste");
  await expect(page.locator("#paste-share")).toBeHidden();
});

test("the paste page takes a chosen file, and a PDF is pasted as itself", async ({ page, request }) => {
  await page.goto("/paste");
  await page.locator("#paste-file").setInputFiles({ name: "deploy.sh", mimeType: "text/x-shellscript", buffer: Buffer.from("#!/bin/sh\nset -e\necho ok\n") });
  await expect(page.locator("#paste-source")).toHaveValue(/echo ok/);
  await expect(page.locator("#paste-title")).toHaveValue("deploy.sh");
  await expect(page.locator("#paste-meta")).toContainText("Shell");
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  await page.locator("#paste-file").setInputFiles({ name: "spec.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator("#paste-source")).toBeDisabled();
  await expect(page.locator("#paste-meta")).toContainText("spec.pdf");
  await page.locator("#paste-submit").click();
  const link = await page.locator("#paste-result .copy-value input").inputValue();
  const raw = await request.get(`${link}/raw`);
  expect(raw.headers()["content-type"]).toBe("application/pdf");
  expect((await raw.body()).equals(pdf)).toBe(true);
  const json = await (await request.get(`/api/v1/pastes/${link.split("/p/")[1]}`)).json();
  expect(json.language).toBe("binary");
  expect(json.mime).toBe("application/pdf");
  await page.goto(link);
  await expect(page.locator("#media-content embed")).toHaveAttribute("type", "application/pdf");
  await expect(page.locator("#edit-mode")).toBeDisabled();
});

test("the editor has a Paste link button that works while signed out", async ({ page }) => {
  await page.goto("/viewer");
  await expect(page.locator("#document-name")).toHaveText("Welcome.md");
  await page.locator("#paste-share").click();
  const dialog = page.locator("dialog.cloud-dialog");
  await expect(dialog.locator("h2")).toHaveText("Paste");
  await dialog.locator("button.primary-action").click();
  const link = await dialog.locator(".copy-value input").inputValue();
  expect(link).toMatch(/\/p\/[A-Za-z0-9_-]{43}$/);
  await expect(dialog).toContainText(`curl ${link}/raw`);
  await expect(dialog.locator("a[href='/paste']")).toBeVisible();
});
