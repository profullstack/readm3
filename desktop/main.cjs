/**
 * readm3 desktop: the readm3.com editor in its own window.
 *
 * The window loads https://readm3.com/viewer, so sign-in, sync, sharing and pastes
 * work as they do on the web, and the service worker keeps it working offline once
 * it has loaded. A copy of the editor ships inside the app (resources/site) and is
 * served as app://readm3 when readm3.com cannot be reached on a first launch.
 *
 * Files and folders named on the command line (`readm3 edit .`, like `subl .`), or
 * handed over by the desktop's "Open with", are listed here and read by the page
 * through preload.cjs, which can read and write only files this process listed.
 *
 * readm3:// links ("Open in app" on readm3.com) open a readm3.com page in this window, and
 * "Sign in with your browser" signs the window in through the system browser, where the
 * person's password manager is: OAuth with a loopback redirect, then one exchange of the
 * token for a session cookie in this window (POST /oauth/desktop-session).
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require("electron");
const { createHash, randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { watch } = require("node:fs");
const { open, readFile, readdir, writeFile, stat } = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const ORIGIN = (process.env.READM3_URL || "https://readm3.com").replace(/\/$/, "");
const LOCAL = "app://readm3";
/** The largest file a signed-in account may keep (src/blob-store.ts); the page applies its own limits again. */
const MAX_FILE_BYTES = 5 * 1024 ** 3;
const MAX_RANGE = 16 * 1024 * 1024;
/** A signed-in workspace's file count (src/blob-store.ts); the walk stops there. */
const MAX_FILES = 1_000_000;
const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "venv", "__pycache__", ".git"]);
const NEVER = /\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|o|a|class|jar|war|wasm|bin|dat|db|sqlite|sqlite3|mp3|mp4|m4a|mov|avi|mkv|webm|ogg|wav|flac|woff2?|ttf|otf|eot|psd|ai|doc|docx|xls|xlsx|ppt|pptx|iso|dmg|pkg|deb|rpm|apk|lock)$/i;
/** The bundled editor: inside the package, or the repo's site build when run with `electron .`. */
const SITE = app.isPackaged ? join(process.resourcesPath, "site") : join(__dirname, "..", "site", "dist");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("readm3");

/** Paths this process opened for the page; the only paths it may write. */
const opened = new Set();
/**
 * The paths opened before, kept in userData so a restart can watch them again: without it
 * the page's copy of a file saved in another editor while readm3 was closed (or after a
 * restart) never reloads. Only paths the person opened here are ever written to it.
 */
const KEEP_OPENED = 200_000;
let openedFile;
let keeping;
function remember(path) {
  opened.delete(path);
  opened.add(path);
  keep();
  watchFolder(dirname(path));
}

/**
 * Opened files are watched, so a save in another editor (Sublime, vim, a build) reaches the
 * page at once instead of on its next poll. The folder is watched, not the file: an editor
 * that saves by writing a new file and renaming it over the old one would end a watch on
 * the file itself. inotify watches are a per-user budget shared with every other program,
 * so at most MAX_WATCHED folders are watched, the most recently opened first; the page's
 * poll still covers the rest.
 */
const MAX_WATCHED = 2000;
const watchers = new Map();
/** Paths with a change waiting to be sent, so one save (often several events) sends once. */
const changes = new Set();
let flushing;
function watchFolder(folder) {
  const existing = watchers.get(folder);
  if (existing) { watchers.delete(folder); watchers.set(folder, existing); return; }
  let watcher;
  try {
    watcher = watch(folder, { persistent: false }, (_event, name) => {
      if (!name) return;
      const path = join(folder, name.toString());
      if (!opened.has(path)) return;
      changes.add(path);
      // Sent once the events stop: a save is often a truncate and several writes.
      clearTimeout(flushing);
      flushing = setTimeout(() => {
        flushing = undefined;
        const paths = [...changes];
        changes.clear();
        if (window && !window.isDestroyed()) window.webContents.send("files-changed", paths);
      }, 60);
    });
  } catch { return; /* Gone, unreadable, or out of watches: the page's poll covers it. */ }
  watcher.on("error", () => { watcher.close(); if (watchers.get(folder) === watcher) watchers.delete(folder); });
  watchers.set(folder, watcher);
  if (watchers.size > MAX_WATCHED) {
    const [oldest, old] = watchers.entries().next().value;
    old.close();
    watchers.delete(oldest);
  }
}
function keep() {
  if (!openedFile || keeping) return;
  keeping = setTimeout(() => {
    keeping = undefined;
    const kept = [...opened].slice(-KEEP_OPENED);
    void writeFile(openedFile, JSON.stringify(kept)).catch(() => { /* Watched this session only. */ });
  }, 1000);
}
/** Files waiting for the page to ask for them (it asks once it has loaded). */
let pending = [];
let window;

/**
 * Lists files, and every file under a folder. A folder's files carry `relative`, their
 * path from the folder's parent ("notes/todo.md"), so the page opens them as the folder.
 * No bytes travel with the list: the page reads each file when it needs it (read-file,
 * read-range), so a folder of thousands of files is never one message of gigabytes.
 */
async function load(paths, cwd = process.cwd()) {
  const files = [];
  const add = async (path, info, relative) => {
    if (info.size > MAX_FILE_BYTES || files.length >= MAX_FILES) return;
    files.push({ path, name: basename(path), relative, size: info.size });
    remember(path);
  };
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      try {
        if (entry.isDirectory()) await walk(path, relative);
        else if (entry.isFile() && !NEVER.test(entry.name)) await add(path, await stat(path), relative);
      } catch { /* An unreadable entry is skipped; the rest of the folder still opens. */ }
    }
  };
  for (const input of paths) {
    const path = resolve(cwd, input);
    try {
      const info = await stat(path);
      if (info.isDirectory()) await walk(path, basename(path) || path);
      else if (info.isFile()) await add(path, info);
    } catch { /* A path that is not readable is ignored, as an editor would. */ }
  }
  return files;
}

/** Arguments that name files, not switches; argv[0] is the binary and, unpackaged, argv[1] is the app. */
// A desktop entry with %U hands local files over as file:// URLs.
const fileArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith("-") && !arg.startsWith("readm3:"))
  .map((arg) => (arg.startsWith("file://") ? fileURLToPath(arg) : arg));
const linkArg = (argv) => argv.find((arg) => arg.startsWith("readm3:"));

/** The readm3.com page a readm3://open?url=… link names; anything off that origin is ignored. */
function linkTarget(link) {
  try {
    const target = new URL(link).searchParams.get("url");
    return target && target.startsWith(`${ORIGIN}/`) ? target : undefined;
  } catch { return undefined; }
}
let launchLink;
function openLink(link) {
  const target = link && linkTarget(link);
  if (!window) { launchLink = target; return; }
  if (window.isMinimized()) window.restore();
  window.focus();
  if (target) void window.loadURL(target);
}

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
/** Sign this window in through the system browser; resolves once the session cookie is set. */
async function signInWithBrowser() {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const code = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("Sign-in timed out. Try again.")), 10 * 60 * 1000);
      server.on("request", (request, response) => {
        const url = new URL(request.url, redirect);
        if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
        const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
        response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><title>readm3</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh"><p>${ok ? "You are signed in to the readm3 desktop app. You can close this tab." : "Sign-in was cancelled. Nothing was shared."}</p>`);
        clearTimeout(timer);
        if (ok) done(url.searchParams.get("code")); else fail(new Error("Sign-in was cancelled."));
      });
      const authorize = new URL(`${ORIGIN}/oauth/authorize`);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: "readm3-desktop", redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state }))
        authorize.searchParams.set(key, value);
      void shell.openExternal(authorize.toString());
    });
    const tokens = await (await fetch(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "readm3-desktop", code, redirect_uri: redirect, code_verifier: verifier }),
    })).json();
    if (!tokens.access_token) throw new Error(tokens.error_description || "Sign-in failed. Try again.");
    const response = await fetch(`${ORIGIN}/oauth/desktop-session`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } });
    const cookie = await response.json();
    if (!response.ok) throw new Error(cookie.error_description || "Sign-in failed. Try again.");
    await session.defaultSession.cookies.set({
      url: ORIGIN, name: cookie.name, value: cookie.value, path: "/", httpOnly: true,
      secure: ORIGIN.startsWith("https:"), sameSite: "lax", expirationDate: Date.now() / 1000 + cookie.maxAge,
    });
    window?.focus();
  } finally { server.close(); }
}

async function openPaths(paths, cwd) {
  const files = await load(paths, cwd);
  if (!files.length) return;
  if (window && !window.webContents.isLoading()) window.webContents.send("open-files", files);
  else pending.push(...files);
}

const trusted = (url) => url.startsWith(`${ORIGIN}/`) || url.startsWith(`${LOCAL}/`);

function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 320,
    title: "readm3", backgroundColor: "#05070a", autoHideMenuBar: false,
    icon: join(SITE, "viewer-assets", "icon-512.png"),
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // Links out of the editor open in the browser; sign-in pages may navigate the window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!/^https:/.test(url) && !trusted(url)) { event.preventDefault(); }
  });
  window.loadURL(launchLink ?? `${ORIGIN}/viewer`).catch(() => window.loadURL(`${LOCAL}/viewer`));
  launchLink = undefined;
}

/** Menu items run the page's own commands by name, the same ones the command palette lists. */
function command(label) {
  return () => window?.webContents.executeJavaScript(`window.readm3Command?.(${JSON.stringify(label)})`, true);
}
function menu() {
  // Accelerators are shown but left to the page, which already handles them.
  const item = (label, run, accelerator) => ({ label, click: run, accelerator, registerAccelerator: false });
  return Menu.buildFromTemplate([
    { label: "File", submenu: [
      item("Open Folder…", command("File: Open folder…")),
      item("Open Files…", command("File: Open files…")),
      item("New Note", command("File: New note")),
      { type: "separator" },
      item("Save", command("File: Save"), "CmdOrCtrl+S"),
      item("Save As…", command("File: Save As…"), "CmdOrCtrl+Shift+S"),
      item("Reload from Disk", command("File: Reload from disk"), "CmdOrCtrl+Shift+R"),
      item("Close Tab", command("File: Close tab")),
      item("Close All but This Tab", command("File: Close all but this tab")),
      item("Close All Tabs", command("File: Close all tabs")),
      { type: "separator" },
      { role: "quit" },
    ] },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      { type: "separator" },
      item("Find and Replace", command("Edit: Find and replace"), "CmdOrCtrl+F"),
    ] },
    { label: "View", submenu: [
      item("Go to File…", command(""), "CmdOrCtrl+P"),
      item("Command Palette…", command(">"), "CmdOrCtrl+Shift+P"),
      item("Toggle Sidebar", command("View: Toggle sidebar")),
      item("Toggle Word Wrap", command("View: Toggle word wrap")),
      { type: "separator" },
      { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }, { role: "togglefullscreen" },
      { type: "separator" }, { role: "reload" }, { role: "toggleDevTools" },
    ] },
    { label: "Help", submenu: [
      item("Keyboard Shortcuts", command("Help: Keyboard shortcuts")),
      item("readm3.com", () => void shell.openExternal(ORIGIN)),
    ] },
  ]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // A second launch ("Open with" while running) hands its files to this window.
  // Its relative paths are relative to where it was started, not to this process.
  app.on("second-instance", (_event, argv, workingDirectory) => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
    void openPaths(fileArgs(argv), workingDirectory);
    if (linkArg(argv)) openLink(linkArg(argv));
  });
  // macOS delivers readm3:// links as events; Windows and Linux put them in argv.
  app.on("open-url", (event, link) => { event.preventDefault(); openLink(link); });
  // macOS hands files over as events (Finder, `open -a readm3`), before and after launch.
  app.on("open-file", (event, path) => { event.preventDefault(); void openPaths([path]); });
  app.whenReady().then(async () => {
    openedFile = join(app.getPath("userData"), "opened.json");
    try { for (const path of JSON.parse(await readFile(openedFile, "utf8"))) if (typeof path === "string") opened.add(path); }
    catch { /* First launch, or an unreadable list: files are watched once opened again. */ }
    // The folders of the most recently opened files are watched again, newest last so they stay.
    for (const path of [...opened].slice(-MAX_WATCHED * 4)) watchFolder(dirname(path));
    keep(); // A file macOS handed over before this point.
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const path = pathname === "/viewer" || pathname === "/viewer/" ? "/viewer/index.html" : decodeURIComponent(pathname);
      const file = join(SITE, path);
      if (!file.startsWith(SITE)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    if (app.isPackaged) app.setAsDefaultProtocolClient("readm3");
    ipcMain.handle("launch-files", () => { const files = pending; pending = []; return files; });
    ipcMain.handle("sign-in-with-browser", async (event) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      await signInWithBrowser();
    });
    // The page re-reads a file to notice it changing on disk (a git checkout, a build).
    ipcMain.handle("read-file", async (event, path) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (typeof path !== "string" || !opened.has(path)) throw new Error("readm3 can only read files it opened.");
      const info = await stat(path);
      return { data: new Uint8Array(await readFile(path)), modified: info.mtimeMs };
    });
    // A large file's size and time, so the page notices it change without reading it.
    ipcMain.handle("stat-file", async (event, path) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (typeof path !== "string" || !opened.has(path)) throw new Error("readm3 can only read files it opened.");
      const info = await stat(path);
      return { size: info.size, modified: info.mtimeMs };
    });
    // After a restart: which of the files the page had from disk are still there, with their size.
    ipcMain.handle("reopen-files", async (event, paths) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (!Array.isArray(paths)) throw new Error("Invalid paths.");
      const files = [];
      for (const path of paths) {
        if (typeof path !== "string" || !opened.has(path)) continue;
        try { const info = await stat(path); if (info.isFile()) files.push({ path, name: basename(path), size: info.size }); }
        catch { /* Moved or deleted: the page keeps its copy. */ }
      }
      return files;
    });
    // A workspace file that lost its link to disk (opened before 0.19.0, or it came from sync):
    // found among the paths opened before, else in the home folder, so the page reads it from
    // disk again without asking. Several matches: the most recently changed one.
    ipcMain.handle("find-opened", async (event, relatives, search = false) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (!Array.isArray(relatives)) throw new Error("Invalid paths.");
      const wanted = relatives.filter((relative) => typeof relative === "string" && relative && !relative.split("/").includes("..") && !NEVER.test(relative));
      const found = {};
      const pick = async (relative, paths) => {
        let best;
        for (const path of new Set(paths)) {
          try { const info = await stat(path); if (info.isFile() && info.size <= MAX_FILE_BYTES && (!best || info.mtimeMs > best.modified)) best = { path, name: basename(path), size: info.size, modified: info.mtimeMs }; }
          catch { /* Moved or deleted. */ }
        }
        if (!best) return false;
        remember(best.path);
        found[relative] = [{ path: best.path, name: best.name, size: best.size }];
        return true;
      };
      const matches = (path, relative) => path === relative || path.endsWith(`/${relative}`) || path.endsWith(`\\${relative.replaceAll("/", "\\")}`);
      const byName = new Map();
      for (const path of opened) { const name = basename(path); const list = byName.get(name); if (list) list.push(path); else byName.set(name, [path]); }
      let missing = [];
      for (const relative of wanted) if (!await pick(relative, (byName.get(basename(relative)) ?? []).filter((path) => matches(path, relative)))) missing.push(relative);
      // Searching is asked for only by Reload on one file: a note made in readm3 must never be
      // tied to some unrelated file of the same name.
      if (!missing.length || search !== true) return found;
      // The usual places first: ~/Desktop/notes.md opened as "notes.md" or "Desktop/notes.md".
      const home = app.getPath("home");
      const roots = [home, ...["desktop", "documents", "downloads"].map((name) => { try { return app.getPath(name); } catch { return undefined; } }).filter(Boolean), join(home, "src"), join(home, "notes")];
      const still = [];
      for (const relative of missing) if (!await pick(relative, roots.map((root) => join(root, relative)))) still.push(relative);
      missing = still;
      if (!missing.length) return found;
      // Then a bounded walk of the home folder, for a file opened from deeper in it.
      const names = new Map(missing.map((relative) => [basename(relative), []]));
      const deadline = Date.now() + 4000;
      let folders = 0;
      const walk = async (directory, depth) => {
        if (depth > 6 || folders++ > 50_000 || Date.now() > deadline) return;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path, depth + 1);
          else if (entry.isFile()) names.get(entry.name)?.push(path);
        }
      };
      await walk(home, 0);
      for (const relative of missing) await pick(relative, (names.get(basename(relative)) ?? []).filter((path) => matches(path, relative)));
      return found;
    });
    // "Where is this file?": the person points at it in the system dialog, and it is linked again.
    ipcMain.handle("locate", async (event, name) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        title: `Find ${typeof name === "string" ? basename(name) : "the file"} on disk`,
        defaultPath: typeof name === "string" ? join(app.getPath("home"), basename(name)) : undefined,
        properties: ["openFile"],
      });
      if (canceled || !filePaths[0]) return null;
      const [file] = await load([filePaths[0]]);
      return file ?? null;
    });
    // A large file reaches the page a range at a time, never whole through one message.
    ipcMain.handle("read-range", async (event, path, start, end) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (typeof path !== "string" || !opened.has(path)) throw new Error("readm3 can only read files it opened.");
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > MAX_RANGE) throw new Error("Invalid range.");
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        return new Uint8Array(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
    });
    // Open Folder and Open Files use the system dialog and are read here, like a launch. The
    // page's own picker (showDirectoryPicker) never returns in Electron for a folder Chromium
    // calls sensitive, such as ~/Desktop, and every later click fails with "picker already active".
    ipcMain.handle("pick", async (event, folder) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        title: folder ? "Open Folder" : "Open Files",
        properties: folder ? ["openDirectory"] : ["openFile", "multiSelections"],
      });
      return canceled ? null : load(filePaths);
    });
    // Save As in the system dialog; the chosen path becomes one this process may write.
    ipcMain.handle("save-as", async (event, name) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: typeof name === "string" ? basename(name) : undefined });
      if (canceled || !filePath) return null;
      remember(filePath);
      return { path: filePath, name: basename(filePath) };
    });
    // A page picker that lands on a sensitive folder waits for this answer, forever if no one gives it.
    // The person chose the folder in the system dialog, so readm3's own pages may have it.
    session.defaultSession.on("file-system-access-restricted", (details, callback) => {
      callback(trusted(details.origin) ? "allow" : "deny");
    });
    ipcMain.handle("write-file", async (event, path, data) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (typeof path !== "string" || !opened.has(path)) throw new Error("readm3 can only save files it opened.");
      await writeFile(path, typeof data === "string" ? data : Buffer.from(data));
    });
    Menu.setApplicationMenu(menu());
    pending.push(...await load(fileArgs(process.argv)));
    if (linkArg(process.argv)) launchLink = linkTarget(linkArg(process.argv));
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
