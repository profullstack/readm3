/**
 * readm3 desktop: the readm3.com editor in its own window.
 *
 * The window loads https://readm3.com/viewer, so sign-in, sync, sharing and pastes
 * work as they do on the web, and the service worker keeps it working offline once
 * it has loaded. A copy of the editor ships inside the app (resources/site) and is
 * served as app://readm3 when readm3.com cannot be reached on a first launch.
 *
 * Files named on the command line, or handed over by the desktop's "Open with",
 * are read here and given to the page through preload.cjs, which can write back
 * only to files this process gave it.
 */
const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell } = require("electron");
const { readFile, writeFile, stat } = require("node:fs/promises");
const { basename, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const ORIGIN = (process.env.READM3_URL || "https://readm3.com").replace(/\/$/, "");
const LOCAL = "app://readm3";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** The bundled editor: inside the package, or the repo's site build when run with `electron .`. */
const SITE = app.isPackaged ? join(process.resourcesPath, "site") : join(__dirname, "..", "site", "dist");

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName("readm3");

/** Paths this process opened for the page; the only paths it may write. */
const opened = new Set();
/** Files waiting for the page to ask for them (it asks once it has loaded). */
let pending = [];
let window;

async function load(paths) {
  const files = [];
  for (const input of paths) {
    const path = resolve(input);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      files.push({ path, name: basename(path), data: new Uint8Array(await readFile(path)) });
      opened.add(path);
    } catch { /* A path that is not a readable file is ignored, as an editor would. */ }
  }
  return files;
}

/** Arguments that name files, not switches; argv[0] is the binary and, unpackaged, argv[1] is the app. */
const fileArgs = (argv) => argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith("-"));

async function openPaths(paths) {
  const files = await load(paths);
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
  app.on("second-instance", (_event, argv) => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
    void openPaths(fileArgs(argv));
  });
  app.whenReady().then(async () => {
    protocol.handle("app", (request) => {
      const { pathname } = new URL(request.url);
      const path = pathname === "/viewer" || pathname === "/viewer/" ? "/viewer/index.html" : decodeURIComponent(pathname);
      const file = join(SITE, path);
      if (!file.startsWith(SITE)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    ipcMain.handle("launch-files", () => { const files = pending; pending = []; return files; });
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
