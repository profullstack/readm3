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
      writeFile(join(root, "node_modules", "ignored.md"), "# Dependency"),
      writeFile(join(root, ".hidden", "secret.md"), "# Hidden"),
    ]);
    await page.locator("#folder-input").setInputFiles(root);
    await expect(page.locator("#document-content")).toContainText("Folder readme");
    const names = await page.locator("#file-list .row-name").allTextContents();
    expect(names).not.toContain("ignored.md");
    expect(names).not.toContain("secret.md");
    expect(names).not.toContain("notes.txt");
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
  expect((await request.get("/%E0%A4%A")).status()).toBe(404);
});
