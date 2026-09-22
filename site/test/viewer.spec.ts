import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.beforeEach(async ({ page }) => {
  await page.goto("/viewer");
  await expect(page.locator("#document-name")).toHaveText("Welcome.md");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
});

test("reads the starter workspace and supports file filtering and keyboard navigation", async ({ page }) => {
  await expect(page.locator("#document-content")).toContainText("Your docs. Your space.");
  await page.locator("#reader").focus();
  await page.keyboard.press("/");
  await expect(page.locator("#filter")).toBeFocused();
  await page.locator("#filter").fill("readme");
  await expect(page.locator("#file-list button")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#document-name")).toHaveText("README.md");
  await page.keyboard.press("Escape");
  await expect(page.locator("#filter")).toHaveValue("");
  await page.locator("#file-list .folder-row").click();
  await expect(page.locator("#file-list .folder-row")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#file-list .folder-row")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#reader").focus();
  await page.keyboard.press("?");
  await expect(page.locator("#help-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#help-dialog")).not.toBeVisible();
});

test("imports safely, edits, downloads exact source, and restores the draft after reload", async ({ page }) => {
  const source = '# Private note\n\n<script>window.hacked = true</script>\n<img src=x onerror="window.hacked=true">\n\n**Read me**';
  await page.locator("#files-input").setInputFiles({ name: "private.md", mimeType: "text/markdown", buffer: Buffer.from(source) });
  await expect(page.locator("#document-name")).toHaveText("private.md");
  await expect(page.locator("#document-content")).toContainText("Private note");
  await expect(page.locator("#document-content script, #document-content img")).toHaveCount(0);
  expect(await page.evaluate(() => "hacked" in window)).toBe(false);
  await page.locator("#reader").press("e");
  await expect(page.locator("#editor")).toHaveValue(source);
  const edited = "# Edited privately\n\n- [x] Saved offline\n";
  await page.locator("#editor").fill(edited);
  await page.keyboard.press("Escape");
  await expect(page.locator("#document-content")).toContainText("Edited privately");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("private.md");
  expect(await readFile((await download.path())!, "utf8")).toBe(edited);
  await page.reload();
  await expect(page.locator("#document-name")).toHaveText("private.md");
  await expect(page.locator("#document-content")).toContainText("Edited privately");
});

test("imports a pruned directory with README ordering and retains existing drafts", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "readm3-folder-"));
  try {
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, ".hidden"));
    await Promise.all([
      writeFile(join(root, "docs", "zebra.md"), "# Zebra"),
      writeFile(join(root, "docs", "README.md"), "# Folder readme"),
      writeFile(join(root, "notes.md"), "# Notes"),
      writeFile(join(root, "notes.txt"), "Not Markdown"),
      writeFile(join(root, "app.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 3])),
      writeFile(join(root, "build.tar.gz"), "not really an archive"),
      writeFile(join(root, "node_modules", "ignored.md"), "# Dependency"),
      writeFile(join(root, ".hidden", "secret.md"), "# Hidden"),
    ]);
    await page.locator("#folder-input").setInputFiles(root);
    await expect(page.locator("#document-content")).toContainText("Folder readme");
    const names = await page.locator("#file-list .row-name").allTextContents();
    expect(names).not.toContain("ignored.md");
    expect(names).not.toContain("secret.md");
    expect(names).toContain("notes.txt");
    expect(names).not.toContain("app.bin");
    expect(names).not.toContain("build.tar.gz");
    expect(names.indexOf("README.md")).toBeLessThan(names.indexOf("zebra.md"));
    await page.locator("#edit-mode").click();
    await page.locator("#editor").fill("# My unsaved-to-disk draft");
    await page.locator("#folder-input").setInputFiles(root);
    await page.locator("#filter").fill("README");
    await page.locator('#file-list button[title$="docs/README.md"]').click();
    await expect(page.locator("#document-content")).toContainText("My unsaved-to-disk draft");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps preferences, supports dialects and reveals Reddit spoilers", async ({ page }) => {
  await page.locator("#theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#files-input").setInputFiles({ name: "reddit.md", mimeType: "text/markdown", buffer: Buffer.from("# Spoilers\n\n>!secret ending!<\n") });
  await page.locator("#flavor").selectOption("reddit");
  await expect(page.locator("#document-content")).not.toContainText("secret ending");
  await page.locator("#spoilers").click();
  await expect(page.locator("#document-content")).toContainText("secret ending");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.locator("#theme")).toHaveValue("light");
  await expect(page.locator("#flavor")).toHaveValue("reddit");
});

test("opens GitHub file links through the raw host and reports blocked URLs", async ({ page }) => {
  await page.route("https://raw.githubusercontent.com/example/docs/main/guide.md", (route) => route.fulfill({ contentType: "text/markdown", body: "# Remote guide\n\nFetched directly." }));
  await page.locator("#open-url").click();
  await page.locator("#url-input").fill("https://github.com/example/docs/blob/main/guide.md");
  await page.locator("#load-url").click();
  await expect(page.locator("#document-name")).toHaveText("guide.md");
  await expect(page.locator("#document-content")).toContainText("Remote guide");
  await page.route("https://example.com/blocked.md", (route) => route.abort());
  await page.locator("#open-url").click();
  await page.locator("#url-input").fill("https://example.com/blocked.md");
  await page.locator("#load-url").click();
  await expect(page.locator("#url-error")).toContainText("CORS");
  await expect(page.locator("#document-name")).toHaveText("guide.md");
});

test("opens a document named in the url query parameter, and shows the dialog when it fails", async ({ page }) => {
  await page.route("https://fleetsysops.com/manifesto.md", (route) => route.fulfill({ contentType: "text/markdown", headers: { "access-control-allow-origin": "*" }, body: "# Fleet SysOps Manifesto\n\nWe test in prod." }));
  await page.goto("/viewer?url=https://fleetsysops.com/manifesto.md");
  await expect(page.locator("#document-name")).toHaveText("manifesto.md");
  await expect(page.locator("#document-content")).toContainText("We test in prod.");
  await expect(page.locator("#url-dialog")).not.toBeVisible();
  await page.route("https://example.com/missing.md", (route) => route.fulfill({ status: 404, contentType: "text/plain", headers: { "access-control-allow-origin": "*" }, body: "nope" }));
  await page.goto("/viewer?url=https://example.com/missing.md");
  await expect(page.locator("#url-dialog")).toBeVisible();
  await expect(page.locator("#url-input")).toHaveValue("https://example.com/missing.md");
  await expect(page.locator("#url-error")).toContainText("HTTP 404");
  await expect(page.locator("#document-name")).not.toHaveText("missing.md");
});

test("shares a private paste link without an account, opens it read-only, and deletes it", async ({ page, context }) => {
  await page.locator("#files-input").setInputFiles({ name: "secret-notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Secret notes\n\nRoot everywhere.\n") });
  await expect(page.locator("#document-name")).toHaveText("secret-notes.md");
  await page.locator("#share").click();
  const dialog = page.locator("dialog.cloud-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("select[name=expiresIn]").selectOption("1d");
  await dialog.locator("button.primary-action").click();
  const link = await dialog.locator(".copy-value input").inputValue();
  expect(link).toMatch(/\/p\/[A-Za-z0-9_-]{43}$/);
  const reader = await context.newPage();
  await reader.goto(link);
  await expect(reader.locator("#document-name")).toHaveText("secret-notes.md");
  await expect(reader.locator("#document-content")).toContainText("Root everywhere.");
  await expect(reader.locator("#save-status")).toContainText("Private link");
  await expect(reader.locator("#edit-mode")).toBeDisabled();
  await expect(reader.locator("#share")).toBeHidden();
  reader.once("dialog", (d) => void d.accept());
  await reader.locator("#paste-delete").click();
  await expect(reader).toHaveURL(/\/viewer$/);
  await reader.goto(link);
  await expect(reader.locator("#document-name")).toHaveText("Paste unavailable");
});

test("renders a JSON paste highlighted, folds it, copies it, and serves its raw text", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const created = await request.post("/api/v1/pastes", { data: { source: '{"fleet":{"name":"vienna","live":true,"tags":["a","b"]},"count":2}' } });
  expect(created.status()).toBe(201);
  const paste = await created.json();
  expect(paste.language).toBe("json");
  expect(paste.title).toBe("paste.json");
  await page.goto(paste.url);
  await expect(page.locator("#document-name")).toHaveText("paste.json");
  await expect(page.locator("#document-info")).toContainText("JSON");
  await expect(page.locator("#document-content")).toBeHidden();
  const code = page.locator("#code-content");
  await expect(code).toBeVisible();
  await expect(code.locator(".code-line")).toHaveCount(11);
  await expect(code.locator(".hljs-attr").first()).toBeVisible();
  await expect(code.locator(".hljs-string").first()).toHaveText('"vienna"');
  await expect(page.locator("#flavor-label")).toBeHidden();
  await expect(page.locator("#code-tools")).toBeVisible();
  await expect(page.locator("#edit-mode")).toBeDisabled();
  await expect(page.locator("#raw-link")).toHaveAttribute("href", `/p/${paste.url.split("/p/")[1]}/raw`);
  // Fold the "fleet" object: its four inner lines and the closing brace disappear behind a marker.
  const fleetLine = code.locator(".code-line").nth(1);
  await fleetLine.hover();
  await fleetLine.locator(".fold").click();
  await expect(fleetLine).toHaveClass(/folded/);
  await expect(fleetLine.locator(".fold-marker")).toContainText("7 lines }");
  await expect(code.locator(".code-line:visible")).toHaveCount(4);
  await page.locator("#unfold-all").click();
  await expect(code.locator(".code-line:visible")).toHaveCount(11);
  await page.locator("#fold-all").click();
  await expect(code.locator(".code-line:visible")).toHaveCount(1);
  await page.locator("#unfold-all").click();
  await page.locator("#copy").click();
  await expect(page.locator("#notice")).toContainText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied)).toEqual({ fleet: { name: "vienna", live: true, tags: ["a", "b"] }, count: 2 });
  expect(copied).toContain("\n  ");
  const raw = await request.get(paste.raw);
  expect(raw.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(await raw.text()).toBe('{"fleet":{"name":"vienna","live":true,"tags":["a","b"]},"count":2}');
  const download = await request.get(`${paste.raw}?download=1`);
  expect(download.headers()["content-type"]).toBe("application/json");
  expect(download.headers()["content-disposition"]).toContain("attachment");
});

test("opens JSON as editable highlighted code, sniffs an unnamed file, and shows a PDF in the browser", async ({ page }) => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  await page.locator("#files-input").setInputFiles([
    { name: "config.json", mimeType: "application/json", buffer: Buffer.from('{"name":"vienna","ports":[80,443]}') },
    { name: "deploy", mimeType: "application/octet-stream", buffer: Buffer.from("#!/usr/bin/env bash\nset -e\necho deploying\n") },
    { name: "spec.pdf", mimeType: "application/pdf", buffer: pdf },
  ]);
  const names = await page.locator("#file-list .row-name").allTextContents();
  expect(names).toEqual(expect.arrayContaining(["config.json", "deploy", "spec.pdf"]));
  await page.locator('#file-list button[title="config.json"]').click();
  await expect(page.locator("#document-name")).toHaveText("config.json");
  await expect(page.locator("#code-content")).toBeVisible();
  await expect(page.locator("#document-content")).toBeHidden();
  await expect(page.locator("#code-content .hljs-attr").first()).toBeVisible();
  await expect(page.locator("#document-info")).toContainText("JSON");
  await expect(page.locator("#file-mark")).toHaveText("JSON");
  await expect(page.locator("#code-tools")).toBeVisible();
  await expect(page.locator("#flavor-label")).toBeHidden();
  // Code is a note like any other: edit it and the highlighted view follows.
  await expect(page.locator("#edit-mode")).toBeEnabled();
  await page.locator("#edit-mode").click();
  await page.locator("#editor").fill('{\n  "name": "berlin"\n}\n');
  await page.keyboard.press("Escape");
  await expect(page.locator("#code-content")).toContainText('"berlin"');
  await expect(page.locator("#code-content .code-line")).toHaveCount(3);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  // No extension: the shebang decides, and the decision survives a reload.
  await page.locator('#file-list button[title="deploy"]').click();
  await expect(page.locator("#document-info")).toContainText("Shell");
  await expect(page.locator("#code-content .hljs-meta").first()).toBeVisible();
  await page.reload();
  await page.locator('#file-list button[title="deploy"]').click();
  await expect(page.locator("#document-info")).toContainText("Shell");
  // A PDF is the browser's job: no editor, an embed, and a note with an escape hatch.
  await page.locator('#file-list button[title="spec.pdf"]').click();
  await expect(page.locator("#media-content")).toBeVisible();
  await expect(page.locator("#media-content embed")).toHaveAttribute("type", "application/pdf");
  await expect(page.locator("#media-content embed")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#document-info")).toContainText("PDF");
  await expect(page.locator("#edit-mode")).toBeDisabled();
  await expect(page.locator("#copy")).toBeHidden();
  await expect(page.locator("#code-content")).toBeHidden();
  const download = page.waitForEvent("download");
  await page.locator("#download").click();
  expect((await download).suggestedFilename()).toBe("spec.pdf");
});

test("still renders a Markdown paste as a document", async ({ page, request }) => {
  const created = await request.post("/api/v1/pastes", { data: { source: "# Fleet notes\n\nWe test in prod.\n" } });
  const paste = await created.json();
  expect(paste.language).toBe("markdown");
  await page.goto(paste.url);
  await expect(page.locator("#document-name")).toHaveText("Fleet notes.md");
  await expect(page.locator("#document-content")).toContainText("We test in prod.");
  await expect(page.locator("#code-content")).toBeHidden();
  await expect(page.locator("#code-tools")).toBeHidden();
  await expect(page.locator("#copy")).toBeVisible();
  await expect(page.locator("#raw-link")).toBeVisible();
});

test("installs a complete offline shell and restores edited documents after an offline reload", async ({ page, context, request }) => {
  const manifestResponse = await request.get("/viewer.webmanifest");
  expect(manifestResponse.headers()["content-type"]).toContain("manifest+json");
  const manifest = await manifestResponse.json();
  expect(manifest.start_url).toBe("/viewer");
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
  await page.locator("#new-file").click();
  await page.locator("#editor").fill("# An offline draft\n\nStill here.");
  await page.keyboard.press("Escape");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#document-content")).toContainText("An offline draft");
  await expect(page.locator("#connection")).toContainText("Offline");
  await page.locator("#theme").selectOption("nord");
  await page.locator("#edit-mode").click();
  await page.locator("#editor").fill("# Edited offline too");
  await page.keyboard.press("Escape");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  await page.reload();
  await expect(page.locator("#document-content")).toContainText("Edited offline too");
});

test("uses a mobile drawer and keeps all controls within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#file-pane")).not.toBeVisible();
  await page.locator("#toggle-files").click();
  await expect(page.locator("#file-pane")).toBeVisible();
  await page.locator('#file-list button[title="README.md"]').click();
  await expect(page.locator("#file-pane")).not.toBeVisible();
  await expect(page.locator("#document-name")).toHaveText("README.md");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const id of ["download", "theme", "flavor", "spoilers"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  }
});

test("rejects oversized files without replacing the active document", async ({ page }) => {
  await page.locator("#files-input").setInputFiles({ name: "huge.md", mimeType: "text/markdown", buffer: Buffer.alloc(4 * 1024 * 1024 + 1, "a") });
  await expect(page.locator("#notice")).toContainText("skipped");
  await expect(page.locator("#document-name")).toHaveText("Welcome.md");
});

test("storage failure still permits reading, editing, and downloading", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new Error("Storage denied"); } }));
  await page.reload();
  await expect(page.locator("#document-content")).toContainText("Your docs. Your space.");
  await expect(page.locator("#save-status")).toContainText("storage unavailable");
  await page.locator("#edit-mode").click();
  await page.locator("#editor").fill("# Keep this draft");
  const downloading = page.waitForEvent("download");
  await page.locator("#download").click();
  expect(await readFile((await (await downloading).path())!, "utf8")).toBe("# Keep this draft");
});

test("links to the reader from the homepage and serves worker updates uncached", async ({ request }) => {
  expect(await (await request.get("/")).text()).toContain('href="/viewer"');
  expect((await request.get("/viewer-sw.js")).headers()["cache-control"]).toBe("no-cache");
  // Railway rejects malformed encodings at its edge before they reach this server.
  if (!process.env.READM3_TEST_URL) expect((await request.get("/%E0%A4%A")).status()).toBe(404);
});
