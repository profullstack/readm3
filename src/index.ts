/**
 * readm3 — a terminal markdown reader.
 *
 * The renderer and the file tree are exported so they can be reused: both are
 * pure, and neither needs a terminal.
 */
export { renderMarkdown, parseInline, wrapSpans, plain, toText } from "./markdown.ts";
export type { Line, Span, Role } from "./markdown.ts";
export {
  scan,
  flatten,
  files,
  filterTree,
  matches,
  reveal,
  indexOfPath,
  label,
  MARKDOWN,
  DEFAULT_IGNORE,
} from "./tree.ts";
export type { Entry, FlatEntry, ScanOptions } from "./tree.ts";
export { run } from "./viewer.ts";
export type { ViewerOptions } from "./viewer.ts";
export { main, parseArgs, VERSION } from "./cli.ts";
export type { ParsedArgs } from "./cli.ts";
