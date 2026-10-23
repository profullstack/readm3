import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorInput, editorText } from "./editor.ts";

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
  await expect.poll(() => editorText(page)).toBe(source);
  const edited = "# Edited privately\n\n- [x] Saved offline\n";
  await editorInput(page).fill(edited);
  await page.keyboard.press("Escape");
  await expect(page.locator("#document-content")).toContainText("Edited privately");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  const downloading = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("private.md");
  expect(await readFile((await download.path())!, "utf8")).toBe(edited);
  await page.reload();
  await expect(page.locator("#document-name")).toHaveText("private.md");
  await expect(page.locator("#document-content")).toContainText("Edited privately");
});

test("opens a folder from disk, marks unsaved files, and writes them back with Ctrl+S", async ({ page }) => {
  // Fake File System Access handles: the real pickers cannot be driven headless.
  await page.addInitScript(() => {
    const written: Record<string, string> = {};
    (window as unknown as { written: typeof written }).written = written;
    const file = (name: string, text: string) => ({
      kind: "file", name, getFile: async () => new File([text], name), queryPermission: async () => "granted",
      createWritable: async () => { let out = ""; return { write: async (data: string | Blob) => { out += typeof data === "string" ? data : await data.text(); }, close: async () => { written[name] = out; } }; },
    });
    const directory = (name: string, entries: unknown[]) => ({ kind: "directory", name, values: async function* () { yield* entries; } });
    Object.assign(window, {
      showDirectoryPicker: async () => directory("project", [
        file("app.ts", "const answer = 41;\n"),
        directory("node_modules", [file("ignored.js", "")]),
        directory("src", [file("util.py", "def f():\n    return 1\n")]),
      ]),
      showOpenFilePicker: async () => [file("notes.txt", "hello\n")],
      showSaveFilePicker: async ({ suggestedName }: { suggestedName: string }) => file(`saved-${suggestedName}`, ""),
    });
  });
  await page.reload();
  await page.locator("#open-folder").click();
  await expect(page.locator("#workspace-name")).toHaveText("project");
  await expect(page.locator('#file-list button[title="project/src/util.py"]')).toBeVisible();
  await expect(page.locator('#file-list button[title*="node_modules"]')).toHaveCount(0);
  await expect(page.locator("#document-name")).toHaveText("project/app.ts");
  await expect(page.locator("#save-status")).toHaveText("Saved to disk");
  await editorInput(page).fill("const answer = 42;\n");
  await expect(page.locator("#save-status")).toHaveText("Saved on this device · Ctrl+S writes it to disk");
  await expect(page.locator('#file-list button[title="project/app.ts"]')).toHaveClass(/unsaved/);
  await page.keyboard.press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("Saved to disk · app.ts");
  expect(await page.evaluate(() => (window as unknown as { written: Record<string, string> }).written["app.ts"])).toBe("const answer = 42;\n");
  await expect(page.locator('#file-list button[title="project/app.ts"]')).not.toHaveClass(/unsaved/);
  // A file with no place on disk yet asks where to save it.
  await page.locator('#file-list button[title="Welcome.md"]').click();
  await page.locator("#reader").press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("Saved to disk · saved-Welcome.md");
  expect(await page.evaluate(() => (window as unknown as { written: Record<string, string> }).written["saved-Welcome.md"])).toContain("Your docs. Your space.");
});

test("in the desktop app, opens and saves through the system dialogs, never the page's pickers", async ({ page }) => {
  // The page's pickers hang in Electron on a folder such as ~/Desktop; the desktop bridge must be used instead.
  await page.addInitScript(() => {
    const written: Record<string, string> = {};
    const bytes = (text: string) => new TextEncoder().encode(text);
    const disk: Record<string, string> = { "/home/me/Desktop/todo.md": "# Todo\n", "/home/me/Desktop/sub/a.txt": "a\n" };
    Object.assign(window, {
      written,
      showDirectoryPicker: async () => { throw new Error("page picker used"); },
      showOpenFilePicker: async () => { throw new Error("page picker used"); },
      showSaveFilePicker: async () => { throw new Error("page picker used"); },
      readm3Desktop: {
        takeLaunchFiles: async () => [],
        onOpenFiles: () => {},
        pick: async (folder: boolean) => folder
          ? [{ path: "/home/me/Desktop/todo.md", name: "todo.md", relative: "Desktop/todo.md", size: 7, data: bytes(disk["/home/me/Desktop/todo.md"]) },
            { path: "/home/me/Desktop/sub/a.txt", name: "a.txt", relative: "Desktop/sub/a.txt", size: 2, data: bytes(disk["/home/me/Desktop/sub/a.txt"]) }]
          : null,
        saveAs: async (name: string) => ({ path: `/home/me/${name}`, name }),
        readFile: async (path: string) => ({ data: bytes(written[path] ?? disk[path]), modified: 1 }),
        readRange: async () => new Uint8Array(),
        writeFile: async (path: string, data: string | Uint8Array) => { written[path] = typeof data === "string" ? data : new TextDecoder().decode(data); },
      },
    });
  });
  await page.reload();
  await page.locator("#open-folder").click();
  await expect(page.locator("#workspace-name")).toHaveText("Desktop");
  await expect(page.locator('#file-list button[title="Desktop/sub/a.txt"]')).toBeVisible();
  await page.locator('#file-list button[title="Desktop/todo.md"]').click();
  await expect(page.locator("#save-status")).toHaveText("Saved to disk");
  await page.locator("#reader").press("e");
  await editorInput(page).fill("# Todo\n\n- done\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("Saved to disk · todo.md");
  expect(await page.evaluate(() => (window as unknown as { written: Record<string, string> }).written["/home/me/Desktop/todo.md"])).toBe("# Todo\n\n- done\n");
  // Closing the dialog is not an error.
  await page.locator("#open-files").click();
  await expect(page.locator("#notice")).toBeHidden();
  await page.locator('#file-list button[title="Welcome.md"]').click();
  await page.locator("#reader").press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("Saved to disk · Welcome.md");
  expect(await page.evaluate(() => (window as unknown as { written: Record<string, string> }).written["/home/me/Welcome.md"])).toContain("Your docs. Your space.");
});

test("in the desktop app, a folder comes as a list and large files and images are read from disk, not copied", async ({ page }) => {
  await page.addInitScript(() => {
    const text = new TextEncoder();
    const big = "x".repeat(5 * 1024 * 1024 - 7) + "\nend\n";
    const disk: Record<string, Uint8Array> = {
      "/d/notes.md": text.encode("# Notes\n"),
      "/d/huge.log": text.encode(big),
      // A one-pixel PNG.
      "/d/dot.png": Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)),
    };
    const reads = { file: [] as string[], range: [] as number[] };
    Object.assign(window, {
      reads,
      readm3Desktop: {
        takeLaunchFiles: async () => [],
        onOpenFiles: () => {},
        // As main.cjs lists them since 0.22.0: names and sizes, no bytes.
        pick: async () => Object.entries(disk).map(([path, bytes]) => ({ path, name: path.split("/").at(-1), relative: `d/${path.split("/").at(-1)}`, size: bytes.length })),
        readFile: async (path: string) => { reads.file.push(path); return { data: disk[path], modified: 1 }; },
        readRange: async (path: string, start: number, end: number) => { reads.range.push(end - start); return disk[path].slice(start, end); },
        writeFile: async () => {},
      },
    });
  });
  await page.reload();
  await page.locator("#open-folder").click();
  await expect(page.locator("#workspace-name")).toHaveText("d");
  await expect(page.locator('#file-list button[title="d/huge.log"]')).toBeVisible();
  const reads = () => page.evaluate(() => (window as unknown as { reads: { file: string[]; range: number[] } }).reads);
  // Opening read the small files and only the first 64 KB of the large one.
  expect((await reads()).range).toEqual([64 * 1024]);
  expect((await reads()).file).not.toContain("/d/huge.log");
  // Nothing large was copied into browser storage.
  const keptBlobs = () => page.evaluate(() => new Promise<number>((done) => {
    const open = indexedDB.open("readm3");
    open.onsuccess = () => {
      const db = open.result;
      const names = [...db.objectStoreNames];
      if (!names.length) { done(0); return; }
      let count = 0;
      const tx = db.transaction(names, "readonly");
      for (const name of names) tx.objectStore(name).getAllKeys().onsuccess = (event) => { count += ((event.target as IDBRequest).result as IDBValidKey[]).filter((key) => String(key).startsWith("blob:")).length; };
      tx.oncomplete = () => done(count);
    };
    open.onerror = () => done(0);
  }));
  expect(await keptBlobs()).toBe(0);
  await page.locator('#file-list button[title="d/huge.log"]').click();
  await expect(page.locator("#code-content .large-preview")).toContainText("xxxx");
  await page.locator('#file-list button[title="d/dot.png"]').click();
  await expect(page.locator("#media-content img")).toBeVisible();
  expect(await keptBlobs()).toBe(0);
});

test("keeps a rolling history: opened, saved, changed on disk, with snippets and restore", async ({ page }) => {
  // A fake disk whose file can change under the editor, as a regenerated output.json does.
  await page.addInitScript(() => {
    const disk = { text: '{\n  "status": "ok",\n  "count": 1\n}\n', modified: 1 };
    Object.assign(window, { disk });
    const handle = {
      kind: "file", name: "output.json", queryPermission: async () => "granted",
      getFile: async () => new File([disk.text], "output.json", { lastModified: disk.modified }),
      createWritable: async () => { let out = ""; return { write: async (data: string) => { out += data; }, close: async () => { disk.text = out; disk.modified++; } }; },
    };
    Object.assign(window, {
      showDirectoryPicker: async () => ({ kind: "directory", name: "build", values: async function* () { yield handle; } }),
      showOpenFilePicker: async () => [handle],
      showSaveFilePicker: async () => handle,
    });
  });
  await page.reload();
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  // The folder is named build on purpose: the folder chosen is never skipped as build output.
  await page.locator("#open-folder").click();
  await expect(page.locator("#document-name")).toHaveText("build/output.json");
  await expect(page.locator("#history")).toBeVisible();
  await editorInput(page).fill('{\n  "status": "ok",\n  "count": 2\n}\n');
  await page.keyboard.press("Control+s");
  await expect(page.locator("#save-status")).toHaveText("Saved to disk · output.json");
  // Regenerated behind the editor's back: reloaded, and recorded.
  await page.evaluate(() => {
    const disk = (window as unknown as { disk: { text: string; modified: number } }).disk;
    disk.text = '{\n  "status": "failed",\n  "count": 2,\n  "error": "timeout"\n}\n';
    disk.modified += 10;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator("#notice")).toContainText("changed on disk and was reloaded");
  await expect.poll(() => editorText(page)).toContain('"error": "timeout"');
  await page.locator("#history").click();
  const items = page.locator("#file-history-dialog .history-item");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0).locator(".history-reason")).toHaveText("changed on disk");
  await expect(items.nth(0).locator(".history-stat")).toHaveText("+3 −2");
  await expect(items.nth(0).locator(".history-snippet .added").first()).toContainText('"status": "failed"');
  await expect(items.nth(1).locator(".history-reason")).toHaveText("saved");
  await expect(items.nth(2).locator(".history-stat")).toHaveText("first version");
  // Signed out: the paid summary says how to get it, and nothing is charged.
  await expect(page.locator("#file-history-dialog .history-account")).toContainText("Sign in");
  await expect(page.locator("#file-history-dialog").getByRole("button", { name: "Summarize with AI" })).toHaveCount(0);
  await page.locator("#file-history-dialog").getByRole("button", { name: "Close history" }).click();
  // The document Summarize button, signed out: a sign-in line, no call.
  await page.locator("#summarize").click();
  await expect(page.locator(".summary-dialog")).toContainText("Sign in (free) to summarize documents with AI: 10 a week free");
  await page.locator(".summary-dialog").getByRole("button", { name: "Close summary" }).click();
  await page.locator("#history").click();
  await items.nth(2).getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => editorText(page)).toContain('"count": 1');
  await expect(page.locator("#notice")).toContainText("Restored");
});

test("goes to files with Ctrl+P, runs commands with Ctrl+Shift+P, and keeps open files as tabs", async ({ page }) => {
  await page.locator("#reader").press("Control+p");
  await expect(page.locator("#palette")).toBeVisible();
  // Fuzzy, Sublime style: "exdm" is examples/demo.md.
  await page.keyboard.type("exdm");
  await expect(page.locator("#palette li").first()).toHaveText("examples/demo.md");
  await page.keyboard.press("Enter");
  await expect(page.locator("#palette")).toBeHidden();
  await expect(page.locator("#document-name")).toHaveText("examples/demo.md");
  await expect(page.locator("#tabs .tab")).toHaveCount(2);
  await expect(page.locator('#tabs [aria-selected="true"]')).toHaveAttribute("title", "examples/demo.md");
  // Commands: a theme change and the sidebar, without touching the toolbar.
  await page.locator("#reader").press("Control+Shift+P");
  await page.keyboard.type("toggle sidebar");
  await page.keyboard.press("Enter");
  await expect(page.locator("#file-pane")).toBeHidden();
  await page.keyboard.press("F1");
  await expect(page.locator("#palette input")).toHaveValue(">");
  await page.keyboard.press("Escape");
  // Closing a tab moves to its neighbour and leaves the file in the workspace.
  await page.locator('#tabs [aria-label="Close examples/demo.md"]').click();
  await expect(page.locator("#document-name")).toHaveText("Welcome.md");
  await expect(page.locator("#tabs .tab")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#tabs .tab")).toHaveCount(1);
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
    await editorInput(page).fill("# My unsaved-to-disk draft");
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
  // Code opens in the editor, as in any text editor: line numbers, grammar colors, a caret.
  await expect(page.locator("#editor .cm-lineNumbers")).toBeVisible();
  await expect(page.locator("#editor .tok-propertyName").first()).toBeVisible();
  await expect(page.locator("#edit-mode")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#document-content")).toBeHidden();
  await expect(page.locator("#document-info")).toContainText("JSON");
  await expect(page.locator("#file-mark")).toHaveText("JSON");
  await expect(page.locator("#code-tools")).toBeVisible();
  await expect(page.locator("#flavor-label")).toBeHidden();
  await editorInput(page).fill('{\n  "name": "berlin"\n}\n');
  // Escape is the read view: highlighted, foldable, and following the edit.
  await page.keyboard.press("Escape");
  await expect(page.locator("#code-content")).toBeVisible();
  await expect(page.locator("#code-content .hljs-attr").first()).toBeVisible();
  await expect(page.locator("#code-content")).toContainText('"berlin"');
  await expect(page.locator("#code-content .code-line")).toHaveCount(3);
  await expect(page.locator("#save-status")).toHaveText("Saved on this device");
  // e returns to the same editor with the text still there.
  await page.locator("#reader").press("e");
  await expect.poll(() => editorText(page)).toBe('{\n  "name": "berlin"\n}\n');
  await page.keyboard.press("Escape");
  // No extension: the shebang decides, and the decision survives a reload.
  await page.locator('#file-list button[title="deploy"]').click();
  await expect(page.locator("#document-info")).toContainText("Shell");
  await expect(page.locator("#editor .tok-meta, #editor .tok-comment").first()).toBeVisible();
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
  await editorInput(page).fill("# An offline draft\n\nStill here.");
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
  await editorInput(page).fill("# Edited offline too");
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
  await editorInput(page).fill("# Keep this draft");
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
