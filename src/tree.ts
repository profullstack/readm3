/**
 * The file browser's model: a pruned tree of markdown files under a root.
 *
 * Directories with no markdown anywhere beneath them are dropped, so the pane
 * shows a map of the documentation rather than a map of the repository.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  children: Entry[];
  expanded: boolean;
}

export interface FlatEntry {
  entry: Entry;
  depth: number;
  /** Index of the parent in the same flattened array, or -1 at the top level. */
  parent: number;
}

export interface ScanOptions {
  /** Descend into dot-directories and show dotfiles. Default false. */
  all?: boolean;
  /** Directory names never descended into. */
  ignore?: string[];
  /** Depth cap, counted from the root. Default 12. */
  maxDepth?: number;
  /** Stop after this many entries, so a huge tree cannot hang the UI. */
  maxEntries?: number;
}

export const MARKDOWN = /\.(?:md|markdown|mdown|mkd|mdx)$/i;

export const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pnpm-store",
];

/** README first, then the rest alphabetically; directories lead. */
function order(a: Entry, b: Entry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  if (!a.dir) {
    const ra = /^readme\b/i.test(a.name);
    const rb = /^readme\b/i.test(b.name);
    if (ra !== rb) return ra ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function scan(root: string, options: ScanOptions = {}): Entry[] {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const maxDepth = options.maxDepth ?? 12;
  const budget = { left: options.maxEntries ?? 5000 };

  const walk = (dir: string, depth: number): Entry[] => {
    if (depth > maxDepth || budget.left <= 0) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const entries: Entry[] = [];
    for (const name of names) {
      if (budget.left <= 0) break;
      if (!options.all && name.startsWith(".")) continue;
      if (ignore.has(name)) continue;
      const path = join(dir, name);
      let isDir: boolean;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const children = walk(path, depth + 1);
        if (children.length === 0) continue;
        budget.left--;
        entries.push({ name, path, dir: true, children, expanded: depth < 1 });
      } else if (MARKDOWN.test(name)) {
        budget.left--;
        entries.push({ name, path, dir: false, children: [], expanded: false });
      }
    }
    return entries.sort(order);
  };

  return walk(root, 0);
}

/**
 * Depth-first order of what is currently visible. Matches HQTUI's own tree
 * flattening, so a selected index means the same thing to both.
 */
export function flatten(entries: Entry[], depth = 0, parent = -1, out: FlatEntry[] = []): FlatEntry[] {
  for (const entry of entries) {
    const index = out.length;
    out.push({ entry, depth, parent });
    if (entry.dir && entry.expanded) flatten(entry.children, depth + 1, index, out);
  }
  return out;
}

/** Every markdown file in the tree, in display order. */
export function files(entries: Entry[], out: Entry[] = []): Entry[] {
  for (const entry of entries) {
    if (entry.dir) files(entry.children, out);
    else out.push(entry);
  }
  return out;
}

/**
 * A copy of the tree keeping only files whose path matches `query`, with every
 * surviving directory expanded. Matching is a case-insensitive subsequence, so
 * "gsg" finds "getting-started-guide.md".
 */
export function filterTree(entries: Entry[], query: string, root: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  const keep = (list: Entry[]): Entry[] => {
    const result: Entry[] = [];
    for (const entry of list) {
      if (entry.dir) {
        const children = keep(entry.children);
        if (children.length > 0) result.push({ ...entry, children, expanded: true });
      } else if (matches(relative(root, entry.path), q)) {
        result.push(entry);
      }
    }
    return result;
  };
  return keep(entries);
}

/** Case-insensitive subsequence match, with a substring hit always winning. */
export function matches(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h.includes(n)) return true;
  let i = 0;
  for (const ch of n) {
    const at = h.indexOf(ch, i);
    if (at < 0) return false;
    i = at + 1;
  }
  return true;
}

/** Expand every directory on the way to `path`, so a file can be revealed. */
export function reveal(entries: Entry[], path: string): boolean {
  for (const entry of entries) {
    if (entry.path === path) return true;
    if (entry.dir && path.startsWith(entry.path + sep) && reveal(entry.children, path)) {
      entry.expanded = true;
      return true;
    }
  }
  return false;
}

/** Index of `path` in the flattened list, or -1. */
export function indexOfPath(flat: FlatEntry[], path: string): number {
  return flat.findIndex((f) => f.entry.path === path);
}

/** A short label for the header: the path relative to the root. */
export function label(root: string, path: string): string {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") ? rel : basename(path);
}
