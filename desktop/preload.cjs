/**
 * The bridge the page uses for files the desktop opened (command line, "Open with").
 * It exists only on readm3's own pages, and main.cjs writes only to files it opened.
 */
const { contextBridge, ipcRenderer } = require("electron");

const origin = location.origin;
// READM3_URL points the app at a local server while developing it.
const custom = typeof process !== "undefined" ? process.env?.READM3_URL?.replace(/\/$/, "") : undefined;
if (origin === "https://readm3.com" || origin === "app://readm3" || (custom && origin === custom)) {
  contextBridge.exposeInMainWorld("readm3Desktop", {
    takeLaunchFiles: () => ipcRenderer.invoke("launch-files"),
    signInWithBrowser: () => ipcRenderer.invoke("sign-in-with-browser"),
    onOpenFiles: (callback) => { ipcRenderer.on("open-files", (_event, files) => callback(files)); },
    readFile: (path) => ipcRenderer.invoke("read-file", path),
    readRange: (path, start, end) => ipcRenderer.invoke("read-range", path, start, end),
    stat: (path) => ipcRenderer.invoke("stat-file", path),
    writeFile: (path, data) => ipcRenderer.invoke("write-file", path, data),
    pick: (folder) => ipcRenderer.invoke("pick", folder),
    saveAs: (name) => ipcRenderer.invoke("save-as", name),
  });
}
