/**
 * The reader: a file browser on the left, the document on the right.
 *
 * The right pane has two modes. Reading renders the buffer through
 * `markdown.ts`; editing shows the same buffer raw, with a caret. Both read the
 * same text, so leaving edit mode is all it takes to see the change rendered —
 * there is no separate preview to keep in step.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createApp, stringWidth, type Container, type Theme } from "@profullstack/hqtui";
import {
  backspace,
  breakRun,
  createEditor,
  del,
  indent,
  insert,
  killToLineEnd,
  killToLineStart,
  markSaved,
  moveDocEnd,
  moveDocStart,
  moveDown,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveUp,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  newline,
  redo,
  text as bufferText,
  undo,
  type Editor,
} from "./editor.ts";
import { DEFAULT_FLAVOR, type Flavor } from "./flavors.ts";
import { renderMarkdown, type Line } from "./markdown.ts";
import { colorOf } from "./roles.ts";
import {
  filterTree,
  flatten,
  indexOfPath,
  label as pathLabel,
  reveal,
  scan,
  type Entry,
  type FlatEntry,
} from "./tree.ts";

export interface ViewerOptions {
  /** Directory the browser is rooted at. */
  root: string;
  /** File to open on start. */
  open?: string | undefined;
  theme?: string | undefined;
  /** Sidebar columns. Clamped to the terminal. */
  sidebar?: number | undefined;
  mouse?: boolean | undefined;
  all?: boolean | undefined;
  /** Which markdown dialect's extras to honor. */
  flavor?: Flavor | undefined;
  /** Refuse to edit, for use as a pager. */
  readOnly?: boolean | undefined;
}

/** Files above this size are refused rather than rendered. */
const MAX_BYTES = 4 * 1024 * 1024;

/** A tab is two columns, in the buffer and on screen alike. */
const TAB = "  ";

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const expand = (line: string): string => line.replace(/\t/g, TAB);

/** Where a caret at `col` lands once tabs are expanded. */
const displayCol = (line: string, col: number): number => expand(line.slice(0, col)).length;

export async function run(options: ViewerOptions): Promise<void> {
  const root = resolve(options.root);
  const flavor = options.flavor ?? DEFAULT_FLAVOR;
  const readOnly = options.readOnly ?? false;

  const app = await createApp({
    theme: options.theme,
    mouse: options.mouse !== false,
    // `q` is handled below so it can be typed into the filter, and into the text.
    quitKeys: [],
  });

  let entries: Entry[] = scan(root, { all: options.all ?? false });
  let filter = "";
  let filtering = false;
  let view: Entry[] = entries;
  let flat: FlatEntry[] = flatten(view);
  let selected = 0;
  let pane: "tree" | "view" = "tree";
  let help = false;
  let message = "";

  let openPath: string | null = null;
  /** The open file's text, and the caret into it. Null until a file opens. */
  let buffer: Editor | null = null;
  let mode: "read" | "edit" = "read";
  let spoilers = false;
  let doc: { path: string; width: number; stamp: number; spoilers: boolean; lines: Line[] } | null = null;
  let scroll = 0;
  /** Bumped on every edit, so the rendered document is rebuilt exactly then. */
  let stamp = 0;

  /** A yes/no the next keypress answers. */
  let pending: { message: string; run: () => void } | null = null;

  let sidebar = options.sidebar ?? 0;
  // Last measured pane interiors; the panel header needs them a frame early.
  let viewport = { w: 80, h: 20 };
  let treeHeight = 20;
  // Owned here rather than left to the widget, so a click can be turned back
  // into an index and the view stays put when the selection moves inside it.
  let treeOffset = 0;
  // The edit pane scrolls on both axes: long lines are not wrapped, because a
  // caret in a wrapped line is a lie about where the text is.
  let editTop = 0;
  let editLeft = 0;
  // The panel header quotes numbers only the draw can measure, so a change in
  // geometry or document length schedules exactly one more frame.
  let measured = { total: -1, h: -1 };

  const dirty = (): boolean => buffer?.dirty ?? false;

  const rebuild = (keepPath?: string | null): void => {
    view = filter ? filterTree(entries, filter, root) : entries;
    flat = flatten(view);
    const at = keepPath ? indexOfPath(flat, keepPath) : -1;
    selected = at >= 0 ? at : clamp(selected, 0, Math.max(0, flat.length - 1));
  };

  const openFile = (path: string): void => {
    try {
      const info = statSync(path);
      if (info.size > MAX_BYTES) {
        message = `${basename(path)} is ${(info.size / 1024 / 1024).toFixed(1)} MB — too large to render`;
        return;
      }
      buffer = createEditor(readFileSync(path, "utf8"));
      openPath = path;
      doc = null;
      scroll = 0;
      editTop = 0;
      editLeft = 0;
      mode = "read";
      message = "";
    } catch (error) {
      message = `Cannot read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  /** Do something that would discard unsaved work, asking first if it would. */
  const guard = (what: string, run: () => void): void => {
    if (!dirty()) {
      run();
      return;
    }
    pending = { message: `${basename(openPath ?? "")} has unsaved changes. ${what} anyway?`, run };
  };

  const save = (): void => {
    if (!openPath || !buffer) return;
    try {
      writeFileSync(openPath, bufferText(buffer), "utf8");
      markSaved(buffer);
      message = "";
    } catch (error) {
      message = `Cannot save: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const enterEdit = (): void => {
    if (!buffer) return;
    if (readOnly) {
      message = "Read-only: started with --read-only.";
      return;
    }
    mode = "edit";
    pane = "view";
    breakRun(buffer);
  };

  const maxScroll = (): number => Math.max(0, (doc?.lines.length ?? 0) - viewport.h);

  const moveSelection = (delta: number): void => {
    if (flat.length === 0) return;
    selected = clamp(selected + delta, 0, flat.length - 1);
  };

  const activate = (): void => {
    const current = flat[selected];
    if (!current) return;
    if (current.entry.dir) {
      current.entry.expanded = !current.entry.expanded;
      rebuild(current.entry.path);
    } else {
      const path = current.entry.path;
      guard("Open another file", () => {
        openFile(path);
        pane = "view";
      });
    }
  };

  // Open whatever was asked for, or fall back to the first file in the tree.
  if (options.open) {
    openFile(resolve(options.open));
    if (openPath) {
      reveal(entries, openPath);
      rebuild(openPath);
    }
  }

  /** Keys while the caret is in the text. Returns false when unhandled. */
  const editKey = (event: { key: string; name: string; char?: string; ctrl: boolean; alt: boolean }): void => {
    const ed = buffer as Editor;
    const { key, name, char, ctrl, alt } = event;
    const page = Math.max(1, viewport.h - 2);

    switch (key) {
      case "escape":
      case "ctrl+c":
        // Never a dead key: from the text it steps out, and the next one quits.
        mode = "read";
        breakRun(ed);
        return;
      case "ctrl+s":
        save();
        return;
      case "ctrl+g":
      case "f1":
        // "?" is a character in here, so help moves to a key that is not.
        help = true;
        return;
      case "ctrl+z":
        undo(ed);
        stamp++;
        return;
      case "ctrl+y":
      case "ctrl+shift+z":
        redo(ed);
        stamp++;
        return;
      case "ctrl+k":
        killToLineEnd(ed);
        stamp++;
        return;
      case "ctrl+u":
        killToLineStart(ed);
        stamp++;
        return;
      case "ctrl+a":
        moveHome(ed);
        return;
      case "ctrl+e":
        moveEnd(ed);
        return;
      case "ctrl+home":
        moveDocStart(ed);
        return;
      case "ctrl+end":
        moveDocEnd(ed);
        return;
      case "ctrl+left":
      case "alt+left":
        moveWordLeft(ed);
        return;
      case "ctrl+right":
      case "alt+right":
        moveWordRight(ed);
        return;
      default:
        break;
    }

    switch (name) {
      case "left":
        moveLeft(ed);
        return;
      case "right":
        moveRight(ed);
        return;
      case "up":
        moveUp(ed);
        return;
      case "down":
        moveDown(ed);
        return;
      case "home":
        moveHome(ed);
        return;
      case "end":
        moveEnd(ed);
        return;
      case "pageup":
        moveVertical(ed, -page);
        return;
      case "pagedown":
        moveVertical(ed, page);
        return;
      case "enter":
        newline(ed);
        stamp++;
        return;
      case "backspace":
        backspace(ed);
        stamp++;
        return;
      case "delete":
        del(ed);
        stamp++;
        return;
      case "tab":
        indent(ed);
        stamp++;
        return;
      case "space":
        insert(ed, " ");
        stamp++;
        return;
      default:
        break;
    }

    if (char && !ctrl && !alt) {
      insert(ed, char);
      stamp++;
    }
  };

  app.on("key", (event) => {
    const { key, name, char } = event;

    if (pending) {
      const answer = pending;
      pending = null;
      if (key === "y" || key === "Y") answer.run();
      app.invalidate();
      return;
    }

    if (help) {
      help = false;
      app.invalidate();
      return;
    }

    if (mode === "edit" && buffer) {
      editKey(event);
      app.invalidate();
      return;
    }

    if (filtering) {
      if (key === "escape") {
        filtering = false;
        filter = "";
        rebuild(openPath);
      } else if (name === "enter") {
        filtering = false;
        const current = flat[selected];
        if (current && !current.entry.dir) activate();
      } else if (name === "backspace") {
        filter = filter.slice(0, -1);
        rebuild();
      } else if (name === "up") {
        moveSelection(-1);
      } else if (name === "down") {
        moveSelection(1);
      } else if (char && !event.ctrl && !event.alt) {
        filter += char;
        rebuild();
      }
      app.invalidate();
      return;
    }

    switch (key) {
      case "ctrl+c":
      case "q":
        guard("Quit", () => app.stop());
        app.invalidate();
        return;
      case "ctrl+s":
        save();
        app.invalidate();
        return;
      case "e":
      case "i":
        enterEdit();
        app.invalidate();
        return;
      case "s":
        spoilers = !spoilers;
        doc = null;
        app.invalidate();
        return;
      case "?":
        help = true;
        app.invalidate();
        return;
      case "tab":
        pane = pane === "tree" ? "view" : "tree";
        app.invalidate();
        return;
      case "r": {
        const keep = openPath;
        guard("Reload from disk", () => {
          entries = scan(root, { all: options.all ?? false });
          if (keep) reveal(entries, keep);
          rebuild(keep);
          if (keep) openFile(keep);
        });
        app.invalidate();
        return;
      }
      case "/":
        filtering = true;
        pane = "tree";
        app.invalidate();
        return;
      case "[":
        sidebar = clamp(sidebar - 2, 16, Math.max(16, app.width - 24));
        app.invalidate();
        return;
      case "]":
        sidebar = clamp(sidebar + 2, 16, Math.max(16, app.width - 24));
        app.invalidate();
        return;
      case "escape":
        if (filter) {
          filter = "";
          rebuild(openPath);
        } else {
          pane = "tree";
        }
        app.invalidate();
        return;
      default:
        break;
    }

    if (pane === "tree") {
      switch (key) {
        case "up":
        case "k":
          moveSelection(-1);
          break;
        case "down":
        case "j":
          moveSelection(1);
          break;
        case "pageup":
          moveSelection(-Math.max(1, treeHeight - 1));
          break;
        case "pagedown":
          moveSelection(Math.max(1, treeHeight - 1));
          break;
        case "home":
        case "g":
          selected = 0;
          break;
        case "end":
        case "G":
        case "shift+g":
          selected = Math.max(0, flat.length - 1);
          break;
        case "right":
        case "l":
        case "enter":
        case "space": {
          const current = flat[selected];
          if (current?.entry.dir && current.entry.expanded && key !== "space") moveSelection(1);
          else activate();
          break;
        }
        case "left":
        case "h": {
          const current = flat[selected];
          if (current?.entry.dir && current.entry.expanded) {
            current.entry.expanded = false;
            rebuild(current.entry.path);
          } else if (current && current.parent >= 0) {
            selected = current.parent;
          }
          break;
        }
        default:
          break;
      }
      app.invalidate();
      return;
    }

    const page = Math.max(1, viewport.h - 2);
    switch (key) {
      case "up":
      case "k":
        scroll = clamp(scroll - 1, 0, maxScroll());
        break;
      case "down":
      case "j":
        scroll = clamp(scroll + 1, 0, maxScroll());
        break;
      case "pageup":
      case "b":
        scroll = clamp(scroll - page, 0, maxScroll());
        break;
      case "pagedown":
      case "space":
        scroll = clamp(scroll + page, 0, maxScroll());
        break;
      case "home":
      case "g":
        scroll = 0;
        break;
      case "end":
      case "G":
      case "shift+g":
        scroll = maxScroll();
        break;
      case "left":
      case "h":
        pane = "tree";
        break;
      default:
        break;
    }
    app.invalidate();
  });

  app.render(({ ui, theme, width }) => {
    if (sidebar === 0) sidebar = clamp(Math.round(width * 0.28), 22, 42);
    const side = clamp(sidebar, 16, Math.max(16, width - 24));
    const openRel = openPath ? pathLabel(root, openPath) : "";
    const total = doc?.lines.length ?? 0;
    const percent = total <= viewport.h ? 100 : Math.round((Math.min(scroll + viewport.h, total) / total) * 100);

    ui.column({}, (screen) => {
      screen.row({ size: "fill" }, (panes) => {
        // ------------------------------------------------------- browser
        panes.panel(
          {
            width: side,
            title: filtering || filter ? ` /${filter}` : ` ${basename(root) || root} `,
            titleColor: filter ? theme.warning : theme.title,
            subtitle: filtering ? "▏" : `${flat.length}`,
            borderColor: pane === "tree" ? theme.borderFocused : theme.border,
            padding: [0, 1],
          },
          (p) => {
            treeHeight = p.height;
            const capacity = Math.max(1, p.height);
            if (selected < treeOffset) treeOffset = selected;
            else if (selected >= treeOffset + capacity) treeOffset = selected - capacity + 1;
            treeOffset = clamp(treeOffset, 0, Math.max(0, flat.length - capacity));
            if (flat.length === 0) {
              p.text(filter ? "No match." : "No markdown here.", { fg: theme.muted });
              return;
            }
            p.list({
              items: flat.map(({ entry, depth }) => {
                const indentation = "  ".repeat(depth);
                const glyph = entry.dir ? (entry.expanded ? "▾ " : "▸ ") : "  ";
                const mark = entry.path === openPath && dirty() ? "● " : "";
                const color = entry.dir
                  ? theme.primary
                  : entry.path === openPath
                    ? theme.accent
                    : theme.foreground;
                return { label: `${indentation}${glyph}${mark}${entry.name}`, color };
              }),
              selected,
              offset: treeOffset,
              scrollbar: true,
              onScroll: (delta) => {
                moveSelection(delta * 3);
                app.invalidate();
              },
              onSelectRow: (row) => {
                if (treeOffset + row >= flat.length) return;
                selected = clamp(treeOffset + row, 0, flat.length - 1);
                pane = "tree";
                activate();
                app.invalidate();
              },
              onFocus: () => {
                pane = "tree";
                app.invalidate();
              },
            });
          },
        );

        // -------------------------------------------------------- reader
        const editing = mode === "edit" && buffer !== null;
        panes.panel(
          {
            title: openRel ? ` ${dirty() ? "● " : ""}${openRel} ` : " readm3 ",
            titleColor: editing ? theme.warning : theme.title,
            subtitle: openPath ? (editing ? "EDIT" : `${percent}%`) : undefined,
            footer:
              openPath && editing && buffer
                ? `${buffer.row + 1}:${buffer.col + 1}`
                : openPath && total > 0
                  ? `${Math.min(scroll + viewport.h, total)}/${total}`
                  : undefined,
            borderColor: editing ? theme.warning : pane === "view" ? theme.borderFocused : theme.border,
            padding: [0, 1],
          },
          (p) => {
            const w = p.width;
            const h = p.height;
            viewport = { w, h };
            p.ctx.hit({
              rect: p.surface.hitRect(),
              onScroll: (delta) => {
                if (editing && buffer) moveVertical(buffer, delta * 3);
                else scroll = clamp(scroll + delta * 3, 0, maxScroll());
                app.invalidate();
              },
              onClick: () => {
                pane = "view";
                app.invalidate();
              },
            });

            if (message) {
              p.text(message, { fg: theme.danger, wrap: true });
              return;
            }
            if (!openPath || !buffer) {
              p.spacer("fill");
              p.text("readm3", { fg: theme.title, bold: true, align: "center" });
              p.text("Pick a file on the left. ? for keys.", { fg: theme.muted, align: "center" });
              p.spacer("fill");
              return;
            }

            if (editing) {
              drawEditor(p, buffer, theme, w, h);
              return;
            }

            if (!doc || doc.path !== openPath || doc.width !== w || doc.stamp !== stamp || doc.spoilers !== spoilers) {
              doc = {
                path: openPath,
                width: w,
                stamp,
                spoilers,
                lines: renderMarkdown(bufferText(buffer), w, { flavor, spoilers }),
              };
            }
            scroll = clamp(scroll, 0, Math.max(0, doc.lines.length - h));
            if (measured.total !== doc.lines.length || measured.h !== h) {
              measured = { total: doc.lines.length, h };
              app.invalidate();
            }

            for (const line of doc.lines.slice(scroll, scroll + h)) {
              const spans = line.spans;
              const only = spans[0];
              if (spans.length <= 1) {
                p.text(only?.text ?? "", {
                  height: 1,
                  fg: only ? colorOf(only, theme) : theme.foreground,
                  bold: only?.bold ?? false,
                  italic: only?.italic ?? false,
                  underline: only?.underline ?? false,
                  dim: only?.dim ?? false,
                });
                continue;
              }
              p.row({ height: 1 }, (row) => {
                for (const span of spans) {
                  row.text(span.text, {
                    width: stringWidth(span.text),
                    fg: colorOf(span, theme),
                    bold: span.bold ?? false,
                    italic: span.italic ?? false,
                    underline: span.underline ?? false,
                    dim: span.dim ?? false,
                  });
                }
                row.spacer("fill");
              });
            }
          },
        );
      });

      screen.statusBar({
        items:
          mode === "edit"
            ? [
                { key: "esc", label: "preview" },
                { key: "^s", label: "save" },
                { key: "^z", label: "undo" },
                { key: "^k", label: "kill" },
                { key: "^g", label: "keys" },
              ]
            : filtering
              ? [
                  { key: "type", label: "filter" },
                  { key: "↵", label: "open" },
                  { key: "esc", label: "clear" },
                ]
              : pane === "tree"
                ? [
                    { key: "↑↓", label: "move" },
                    { key: "↵", label: "open" },
                    { key: "←→", label: "fold" },
                    { key: "/", label: "find" },
                    { key: "tab", label: "reader" },
                    { key: "?", label: "keys" },
                    { key: "q", label: "quit" },
                  ]
                : [
                    { key: "↑↓", label: "scroll" },
                    { key: "spc", label: "page" },
                    { key: "e", label: "edit" },
                    { key: "g/G", label: "ends" },
                    { key: "tab", label: "files" },
                    { key: "?", label: "keys" },
                    { key: "q", label: "quit" },
                  ],
        right: [
          { label: openPath ? (dirname(openRel) === "." ? basename(root) : dirname(openRel)) : basename(root) },
          { label: flavor, color: theme.muted },
          { label: theme.name, color: theme.muted },
        ],
      });

      if (pending) {
        screen.modal({ title: " unsaved changes ", width: 56, height: 9 }, (m) => {
          m.spacer(1);
          m.text(pending?.message ?? "", { fg: theme.foreground, align: "center", wrap: true });
          m.spacer(1);
          m.text("y to continue, any other key to stay", { fg: theme.muted, align: "center" });
          m.spacer("fill");
        });
      } else if (help) {
        screen.modal({ title: " readm3 — keys ", width: 56, height: 24 }, (m) => {
          m.keyValues(
            mode === "edit"
              ? [
                  { label: "esc", value: "back to the preview" },
                  { label: "ctrl+g", value: "this help" },
                  { label: "ctrl+s", value: "save" },
                  { label: "ctrl+z / ctrl+y", value: "undo / redo" },
                  { label: "ctrl+k / ctrl+u", value: "kill to end / start" },
                  { label: "ctrl+a / ctrl+e", value: "line start / end" },
                  { label: "ctrl+← →", value: "by word" },
                  { label: "ctrl+home/end", value: "top / bottom" },
                  { label: "enter", value: "split, continuing a list" },
                  { label: "tab", value: "indent two spaces" },
                ]
              : [
                  { label: "↑ ↓  j k", value: "move / scroll" },
                  { label: "→ ← l h", value: "expand / collapse" },
                  { label: "enter", value: "open file" },
                  { label: "e / i", value: "edit this file" },
                  { label: "ctrl+s", value: "save" },
                  { label: "tab", value: "switch pane" },
                  { label: "space / b", value: "page down / up" },
                  { label: "g / G", value: "top / bottom" },
                  { label: "/", value: "filter files" },
                  { label: "s", value: "reveal spoilers" },
                  { label: "esc", value: "clear filter" },
                  { label: "r", value: "rescan and reload" },
                  { label: "[ ]", value: "sidebar width" },
                  { label: "?", value: "this help" },
                  { label: "q / ctrl+c", value: "quit" },
                ],
            { labelColor: theme.accent, labelWidth: 16 },
          );
          m.spacer(1);
          m.text("Any key closes.", { fg: theme.muted, align: "center" });
        });
      }
    });
  });

  /**
   * The raw buffer with a caret.
   *
   * Long lines scroll sideways rather than wrap: a caret inside a wrapped line
   * cannot say honestly which column of the file it is in.
   */
  function drawEditor(p: Container, ed: Editor, theme: Theme, w: number, h: number): void {
    const gutter = Math.max(3, String(ed.lines.length).length + 1);
    const textWidth = Math.max(8, w - gutter - 1);

    // Keep the caret on screen on both axes.
    if (ed.row < editTop) editTop = ed.row;
    else if (ed.row >= editTop + h) editTop = ed.row - h + 1;
    editTop = clamp(editTop, 0, Math.max(0, ed.lines.length - 1));

    const caretCol = displayCol(ed.lines[ed.row] ?? "", ed.col);
    if (caretCol < editLeft) editLeft = caretCol;
    else if (caretCol >= editLeft + textWidth) editLeft = caretCol - textWidth + 1;
    editLeft = Math.max(0, editLeft);

    for (let i = 0; i < h; i++) {
      const row = editTop + i;
      if (row >= ed.lines.length) {
        p.text("", { height: 1 });
        continue;
      }
      const line = expand(ed.lines[row] as string);
      const shown = line.slice(editLeft, editLeft + textWidth);
      const onCaretRow = row === ed.row;
      const caretAt = caretCol - editLeft;

      p.row({ height: 1 }, (r) => {
        r.text(`${String(row + 1).padStart(gutter - 1)} `, {
          width: gutter,
          fg: onCaretRow ? theme.accent : theme.border,
        });
        if (!onCaretRow) {
          r.text(shown, { width: textWidth, fg: theme.foreground });
          return;
        }
        // Split the line so the caret cell can be painted on its own.
        const before = shown.slice(0, caretAt);
        const under = shown.slice(caretAt, caretAt + 1) || " ";
        const after = shown.slice(caretAt + 1);
        if (before) r.text(before, { width: stringWidth(before), fg: theme.foreground });
        r.text(under, { width: Math.max(1, stringWidth(under)), fg: theme.background, bg: theme.cursor });
        if (after) r.text(after, { width: stringWidth(after), fg: theme.foreground });
        r.spacer("fill");
      });
    }
  }

  await app.start();
}
