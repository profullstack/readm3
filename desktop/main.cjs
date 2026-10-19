/**
 * readm3 desktop: the readm3.com editor in its own window.
 *
 * The window loads https://readm3.com/viewer, so sign-in, sync, sharing and pastes
 * work as they do on the web, and the service worker keeps it working offline once
 * it has loaded. A copy of the editor ships inside the app (resources/site) and is
 * served as app://readm3 when readm3.com cannot be reached on a first launch.
 *
 * Files and folders named on the command line (`readm3 edit .`, like `subl .`), or
 * handed over by the desktop's "Open with", are read here and given to the page
 * through preload.cjs, which can write back only to files this process gave it.
 */
const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require("electron");
const { readFile, readdir, writeFile, stat } = require("node:fs/promises");
const { basename, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ORIGIN = (process.env.READM3_URL || "https://readm3.com").replace(/\/$/, "");
const LOCAL = "app://readm3";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** The page's own limits (site/workspace.ts); it applies them again, these only bound the walk. */
const MAX_FILES = 1000;
const IGNORED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "venv", "__pycache__", ".git"]);
const NEVER = /\.(?:zip|gz|tgz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|o|a|class|jar|war|wasm|bin|dat|db|sqlite|sqlite3|mp3|mp4|m4a|mov|avi|mkv|webm|ogg|wav|flac|woff2?|ttf|otf|eot|psd|ai|doc|docx|xls|xlsx|ppt|pptx|iso|dmg|pkg|deb|rpm|apk|lock)$/i;
/** The bundled editor: inside the package, or the repo's site build when run with `electron .`. */
const SITE = app.isPackaged ? join(process.resourcesPath, "site") : join(__dirname, "..", "site", "dist");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("readm3");

/** Paths this process opened for the page; the only paths it may write. */
const opened = new Set();
/** Files waiting for the page to ask for them (it asks once it has loaded). */
let pending = [];
let window;

/**
 * Reads files, and every file under a folder. A folder's files carry `relative`, their
 * path from the folder's parent ("notes/todo.md"), so the page opens them as the folder.
 */
async function load(paths, cwd = process.cwd()) {
  const files = [];
  const add = async (path, info, relative) => {
    if (info.size > MAX_FILE_BYTES || files.length >= MAX_FILES) return;
    files.push({ path, name: basename(path), relative, data: new Uint8Array(await readFile(path)) });
    opened.add(path);
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
const fileArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith("-"));

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
  window.loadURL(`${ORIGIN}/viewer`).catch(() => window.loadURL(`${LOCAL}/viewer`));
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
      item("Close Tab", command("File: Close tab")),
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
  });
  // macOS hands files over as events (Finder, `open -a readm3`), before and after launch.
  app.on("open-file", (event, path) => { event.preventDefault(); void openPaths([path]); });
  app.whenReady().then(async () => {
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const path = pathname === "/viewer" || pathname === "/viewer/" ? "/viewer/index.html" : decodeURIComponent(pathname);
      const file = join(SITE, path);
      if (!file.startsWith(SITE)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    ipcMain.handle("launch-files", () => { const files = pending; pending = []; return files; });
    // The page re-reads a file to notice it changing on disk (a git checkout, a build).
    ipcMain.handle("read-file", async (event, path) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (typeof path !== "string" || !opened.has(path)) throw new Error("readm3 can only read files it opened.");
      const info = await stat(path);
      return { data: new Uint8Array(await readFile(path)), modified: info.mtimeMs };
    });
    ipcMain.handle("write-file", async (event, path, data) => {
      if (!trusted(event.senderFrame?.url ?? "")) throw new Error("Not allowed.");
      if (typeof path !== "string" || !opened.has(path)) throw new Error("readm3 can only save files it opened.");
      await writeFile(path, typeof data === "string" ? data : Buffer.from(data));
    });
    Menu.setApplicationMenu(menu());
    pending.push(...await load(fileArgs(process.argv)));
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
