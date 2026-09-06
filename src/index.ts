/**
 * readm3 — a terminal markdown reader and editor.
 *
 * The renderer, the file tree and the edit buffer are exported so they can be
 * reused: all three are pure, and none of them needs a terminal.
 */
export { renderMarkdown, parseInline, wrapSpans, mergeSpans, normalizeHtml, plain, toText } from "./markdown.ts";
export type { Line, Span, Role, RenderOptions } from "./markdown.ts";
export { FLAVORS, DEFAULT_FLAVOR, isFlavor, lex, lexInline, lexerFor } from "./flavors.ts";
export type { Flavor } from "./flavors.ts";
export { EMOJI, emojiFor } from "./emoji.ts";
export {
  createEditor,
  text,
  lineAt,
  continuation,
  insert,
  newline,
  backspace,
  del,
  killToLineEnd,
  killToLineStart,
  indent,
  undo,
  redo,
  breakRun,
  markSaved,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
  moveVertical,
  moveHome,
  moveEnd,
  moveDocStart,
  moveDocEnd,
  moveWordLeft,
  moveWordRight,
} from "./editor.ts";
export type { Editor, EditKind, Snapshot } from "./editor.ts";
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
export { colorOf } from "./roles.ts";
export {
  printDocument,
  renderAnsi,
  styleSpan,
  colorParams,
  resolveDepth,
  resolveWidth,
  COLOR_MODES,
} from "./print.ts";
export type { PrintOptions, ColorMode } from "./print.ts";
export { run } from "./viewer.ts";
export type { ViewerOptions } from "./viewer.ts";
export { main, parseArgs, USAGE, VERSION } from "./cli.ts";
export type { ParsedArgs } from "./cli.ts";
