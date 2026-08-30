/**
 * The reader: a file browser on the left, the rendered document on the right.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { createApp, stringWidth, type App, type Color, type Theme } from "@profullstack/hqtui";
import { renderMarkdown, type Line, type Span } from "./markdown.ts";
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
}

/** Files above this size are refused rather than rendered. */
const MAX_BYTES = 4 * 1024 * 1024;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Map a span's semantic role onto the active theme. */
function colorOf(span: Span, theme: Theme): Color {
  switch (span.role) {
    case "h1":
      return theme.title;
    case "h2":
      return theme.primary;
    case "h3":
      return theme.secondary;
    case "code":
    case "lang":
    case "bullet":
      return theme.accent;
    case "fence":
      return theme.foreground;
    case "gutter":
    case "rule":
      return theme.border;
    case "link":
    case "url":
      return theme.info;
    case "quote":
      return theme.secondary;
    case "meta":
      return theme.muted;
    case "th":
      return theme.title;
    default:
      return theme.foreground;
  }
}

export async function run(options: ViewerOptions): Promise<void> {
  const root = resolve(options.root);
  const app = await createApp({
    theme: options.theme,
    mouse: options.mouse !== false,
    // `q` is handled below so it can be typed into the filter.
    quitKeys: ["ctrl+c"],
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
  let source: string | null = null;
  let doc: { path: string; width: number; lines: Line[] } | null = null;
  let scroll = 0;

  let sidebar = options.sidebar ?? 0;
  // Last measured pane interiors; the panel header needs them a frame early.
  let viewport = { w: 80, h: 20 };
  let treeHeight = 20;
  // Owned here rather than left to the widget, so a click can be turned back
  // into an index and the view stays put when the selection moves inside it.
  let treeOffset = 0;
  // The panel header quotes numbers only the draw can measure, so a change in
  // geometry or document length schedules exactly one more frame.
  let measured = { total: -1, h: -1 };

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
      source = readFileSync(path, "utf8");
      openPath = path;
      doc = null;
      scroll = 0;
      message = "";
    } catch (error) {
      message = `Cannot read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`;
    }
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
      openFile(current.entry.path);
      pane = "view";
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

  app.on("key", (event) => {
    const { key, name, char } = event;

    if (help) {
      help = false;
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
      case "q":
        app.stop();
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
        entries = scan(root, { all: options.all ?? false });
        if (keep) reveal(entries, keep);
        rebuild(keep);
        if (keep) openFile(keep);
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

  app.render(({ ui, theme, width, height }) => {
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
                const indent = "  ".repeat(depth);
                const glyph = entry.dir ? (entry.expanded ? "▾ " : "▸ ") : "  ";
                const color = entry.dir
                  ? theme.primary
                  : entry.path === openPath
                    ? theme.accent
                    : theme.foreground;
                return { label: `${indent}${glyph}${entry.name}`, color };
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
        panes.panel(
          {
            title: openRel ? ` ${openRel} ` : " readm3 ",
            subtitle: openPath ? `${percent}%` : undefined,
            footer: openPath && total > 0 ? `${Math.min(scroll + viewport.h, total)}/${total}` : undefined,
            borderColor: pane === "view" ? theme.borderFocused : theme.border,
            padding: [0, 1],
          },
          (p) => {
            const w = p.width;
            const h = p.height;
            viewport = { w, h };
            p.ctx.hit({
              rect: p.surface.hitRect(),
              onScroll: (delta) => {
                scroll = clamp(scroll + delta * 3, 0, maxScroll());
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
            if (!openPath || source === null) {
              p.spacer("fill");
              p.text("readm3", { fg: theme.title, bold: true, align: "center" });
              p.text("Pick a file on the left. ? for keys.", { fg: theme.muted, align: "center" });
              p.spacer("fill");
              return;
            }

            if (!doc || doc.path !== openPath || doc.width !== w) {
              doc = { path: openPath, width: w, lines: renderMarkdown(source, w) };
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
        items: filtering
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
                { key: "g/G", label: "ends" },
                { key: "tab", label: "files" },
                { key: "?", label: "keys" },
                { key: "q", label: "quit" },
              ],
        right: [
          { label: openPath ? (dirname(openRel) === "." ? basename(root) : dirname(openRel)) : basename(root) },
          { label: theme.name, color: theme.muted },
        ],
      });

      if (help) {
        screen.modal({ title: " readm3 — keys ", width: 52, height: 18 }, (m) => {
          m.keyValues(
            [
              { label: "↑ ↓  j k", value: "move / scroll" },
              { label: "→ ← l h", value: "expand / collapse" },
              { label: "enter", value: "open file" },
              { label: "tab", value: "switch pane" },
              { label: "space / b", value: "page down / up" },
              { label: "g / G", value: "top / bottom" },
              { label: "/", value: "filter files" },
              { label: "esc", value: "clear filter" },
              { label: "r", value: "rescan and reload" },
              { label: "[ ]", value: "sidebar width" },
              { label: "?", value: "this help" },
              { label: "q / ctrl+c", value: "quit" },
            ],
            { labelColor: theme.accent, labelWidth: 14 },
          );
          m.spacer(1);
          m.text("Any key closes.", { fg: theme.muted, align: "center" });
        });
      }
    });

    void height;
  });

  await app.start();
}
