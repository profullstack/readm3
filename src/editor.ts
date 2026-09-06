/**
 * The edit buffer: lines, a caret, and undo.
 *
 * Nothing here touches a terminal. The viewer owns the keys and the drawing;
 * this owns what the text is, which is the part worth testing — the same split
 * `markdown.ts` makes between parsing and painting.
 *
 * Functions mutate the state they are given and return it. A buffer is a few
 * thousand lines at most, but copying the array on every keystroke to look
 * functional would buy nothing a snapshot in `undo` does not already give.
 */

/** Undo steps kept. Beyond this the oldest are dropped. */
const MAX_UNDO = 250;

/** What the last edit was, so a run of typing collapses into one undo step. */
export type EditKind = "none" | "insert" | "delete" | "newline" | "other";

export interface Snapshot {
  lines: string[];
  row: number;
  col: number;
}

export interface Editor {
  lines: string[];
  row: number;
  col: number;
  /** Column to aim for on vertical motion, so crossing a short line keeps place. */
  goal: number;
  dirty: boolean;
  undo: Snapshot[];
  redo: Snapshot[];
  last: EditKind;
}

/** A list item's shape, for continuing it on the next line. */
const ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\][ \t]+)?/;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function createEditor(source: string): Editor {
  return {
    lines: source.split("\n"),
    row: 0,
    col: 0,
    goal: 0,
    dirty: false,
    undo: [],
    redo: [],
    last: "none",
  };
}

/** The buffer as one string. Round-trips whatever `createEditor` was given. */
export function text(ed: Editor): string {
  return ed.lines.join("\n");
}

export function lineAt(ed: Editor, row: number): string {
  return ed.lines[row] ?? "";
}

function current(ed: Editor): string {
  return lineAt(ed, ed.row);
}

/** Put the caret somewhere legal, and remember the column it was aiming for. */
function settle(ed: Editor, keepGoal = false): Editor {
  ed.row = clamp(ed.row, 0, Math.max(0, ed.lines.length - 1));
  ed.col = clamp(ed.col, 0, current(ed).length);
  if (!keepGoal) ed.goal = ed.col;
  return ed;
}

/* ------------------------------------------------------------------ undo --- */

function snapshot(ed: Editor): Snapshot {
  return { lines: [...ed.lines], row: ed.row, col: ed.col };
}

/**
 * Record the state before an edit.
 *
 * Consecutive edits of the same kind share one step, so undo walks back a word
 * or a run of typing rather than a character.
 */
function checkpoint(ed: Editor, kind: EditKind): void {
  ed.redo.length = 0;
  if (kind !== ed.last || kind === "newline" || kind === "other") {
    ed.undo.push(snapshot(ed));
    if (ed.undo.length > MAX_UNDO) ed.undo.shift();
  }
  ed.last = kind;
  ed.dirty = true;
}

/** Break the current undo run, so the next edit starts a new step. */
export function breakRun(ed: Editor): Editor {
  ed.last = "none";
  return ed;
}

export function undo(ed: Editor): Editor {
  const step = ed.undo.pop();
  if (!step) return ed;
  ed.redo.push(snapshot(ed));
  ed.lines = step.lines;
  ed.row = step.row;
  ed.col = step.col;
  ed.dirty = true;
  ed.last = "none";
  return settle(ed);
}

export function redo(ed: Editor): Editor {
  const step = ed.redo.pop();
  if (!step) return ed;
  ed.undo.push(snapshot(ed));
  ed.lines = step.lines;
  ed.row = step.row;
  ed.col = step.col;
  ed.dirty = true;
  ed.last = "none";
  return settle(ed);
}

/* --------------------------------------------------------------- motions --- */

export function moveLeft(ed: Editor): Editor {
  if (ed.col > 0) ed.col--;
  else if (ed.row > 0) {
    ed.row--;
    ed.col = current(ed).length;
  }
  ed.last = "none";
  return settle(ed);
}

export function moveRight(ed: Editor): Editor {
  if (ed.col < current(ed).length) ed.col++;
  else if (ed.row < ed.lines.length - 1) {
    ed.row++;
    ed.col = 0;
  }
  ed.last = "none";
  return settle(ed);
}

/** Vertical motion aims at `goal`, so a short line in the way is passed over. */
export function moveVertical(ed: Editor, delta: number): Editor {
  ed.row = clamp(ed.row + delta, 0, Math.max(0, ed.lines.length - 1));
  ed.col = Math.min(ed.goal, current(ed).length);
  ed.last = "none";
  return settle(ed, true);
}

export const moveUp = (ed: Editor): Editor => moveVertical(ed, -1);
export const moveDown = (ed: Editor): Editor => moveVertical(ed, 1);

/** Home, but to the first non-blank first — the second press goes to column 0. */
export function moveHome(ed: Editor): Editor {
  const indent = current(ed).match(/^\s*/)?.[0].length ?? 0;
  ed.col = ed.col === indent ? 0 : indent;
  ed.last = "none";
  return settle(ed);
}

export function moveEnd(ed: Editor): Editor {
  ed.col = current(ed).length;
  ed.last = "none";
  return settle(ed);
}

export function moveDocStart(ed: Editor): Editor {
  ed.row = 0;
  ed.col = 0;
  ed.last = "none";
  return settle(ed);
}

export function moveDocEnd(ed: Editor): Editor {
  ed.row = Math.max(0, ed.lines.length - 1);
  ed.col = current(ed).length;
  ed.last = "none";
  return settle(ed);
}

const WORD = /[\p{L}\p{N}_]/u;

export function moveWordLeft(ed: Editor): Editor {
  if (ed.col === 0) return moveLeft(ed);
  const line = current(ed);
  let i = ed.col;
  while (i > 0 && !WORD.test(line[i - 1] as string)) i--;
  while (i > 0 && WORD.test(line[i - 1] as string)) i--;
  ed.col = i;
  ed.last = "none";
  return settle(ed);
}

export function moveWordRight(ed: Editor): Editor {
  const line = current(ed);
  if (ed.col >= line.length) return moveRight(ed);
  let i = ed.col;
  while (i < line.length && WORD.test(line[i] as string)) i++;
  while (i < line.length && !WORD.test(line[i] as string)) i++;
  ed.col = i;
  ed.last = "none";
  return settle(ed);
}

/* ----------------------------------------------------------------- edits --- */

/** Insert text at the caret. Newlines in it split lines, so paste works. */
export function insert(ed: Editor, str: string): Editor {
  if (str === "") return ed;
  checkpoint(ed, str.includes("\n") ? "other" : "insert");
  const line = current(ed);
  const before = line.slice(0, ed.col);
  const after = line.slice(ed.col);
  const parts = str.replace(/\r\n?/g, "\n").split("\n");

  if (parts.length === 1) {
    ed.lines[ed.row] = before + str + after;
    ed.col += str.length;
    return settle(ed);
  }

  const first = `${before}${parts[0] as string}`;
  const last = `${parts[parts.length - 1] as string}${after}`;
  const middle = parts.slice(1, -1);
  ed.lines.splice(ed.row, 1, first, ...middle, last);
  ed.row += parts.length - 1;
  ed.col = (parts[parts.length - 1] as string).length;
  return settle(ed);
}

/**
 * The prefix a new line should inherit: the indent, and the list marker when
 * the caret is leaving one.
 *
 * Returns `null` for an item that has no content, which is the signal to clear
 * it instead — pressing enter twice is how a list ends.
 */
export function continuation(line: string): { prefix: string; clear: boolean } {
  const m = ITEM.exec(line);
  if (!m) return { prefix: line.match(/^[ \t]*/)?.[0] ?? "", clear: false };

  const [marker, indent, bullet, digits, delim, gap, task] = [
    m[0] as string,
    m[1] as string,
    m[2],
    m[3],
    m[4],
    m[5] as string,
    m[6],
  ];
  // Nothing after the marker: the list is over.
  if (line.slice(marker.length).trim() === "") return { prefix: "", clear: true };

  const next = bullet ?? `${Number.parseInt(digits as string, 10) + 1}${delim as string}`;
  return { prefix: `${indent}${next}${gap}${task ? "[ ] " : ""}`, clear: false };
}

/** Split the line at the caret, carrying indentation and list markers over. */
export function newline(ed: Editor): Editor {
  checkpoint(ed, "newline");
  const line = current(ed);
  const before = line.slice(0, ed.col);
  const after = line.slice(ed.col);
  const { prefix, clear } = continuation(before);

  if (clear) {
    // Enter on an empty item empties it rather than making another.
    ed.lines[ed.row] = after;
    ed.lines.splice(ed.row, 0, "");
    ed.row++;
    ed.col = 0;
    return settle(ed);
  }

  ed.lines[ed.row] = before;
  ed.lines.splice(ed.row + 1, 0, prefix + after);
  ed.row++;
  ed.col = prefix.length;
  return settle(ed);
}

export function backspace(ed: Editor): Editor {
  if (ed.col === 0 && ed.row === 0) return ed;
  checkpoint(ed, "delete");
  if (ed.col > 0) {
    const line = current(ed);
    // An indent is removed a level at a time, not a space at a time.
    const before = line.slice(0, ed.col);
    const width = /^[ \t]+$/.test(before) && before.length % 2 === 0 ? 2 : 1;
    ed.lines[ed.row] = line.slice(0, ed.col - width) + line.slice(ed.col);
    ed.col -= width;
    return settle(ed);
  }
  const line = current(ed);
  const above = lineAt(ed, ed.row - 1);
  ed.lines.splice(ed.row - 1, 2, above + line);
  ed.row--;
  ed.col = above.length;
  return settle(ed);
}

/** Delete forward. Joins the next line when the caret is at the end. */
export function del(ed: Editor): Editor {
  const line = current(ed);
  if (ed.col >= line.length && ed.row >= ed.lines.length - 1) return ed;
  checkpoint(ed, "delete");
  if (ed.col < line.length) {
    ed.lines[ed.row] = line.slice(0, ed.col) + line.slice(ed.col + 1);
    return settle(ed);
  }
  ed.lines.splice(ed.row, 2, line + lineAt(ed, ed.row + 1));
  return settle(ed);
}

/** Delete to the end of the line, or join the next when already there. */
export function killToLineEnd(ed: Editor): Editor {
  const line = current(ed);
  if (ed.col >= line.length) return del(ed);
  checkpoint(ed, "other");
  ed.lines[ed.row] = line.slice(0, ed.col);
  return settle(ed);
}

/** Delete from the caret back to the start of the line's text. */
export function killToLineStart(ed: Editor): Editor {
  if (ed.col === 0) return ed;
  checkpoint(ed, "other");
  ed.lines[ed.row] = current(ed).slice(ed.col);
  ed.col = 0;
  return settle(ed);
}

/** Two spaces, the indent the renderer reads back as one list level. */
export function indent(ed: Editor): Editor {
  return insert(ed, "  ");
}

/** Mark the buffer as matching what is on disk. */
export function markSaved(ed: Editor): Editor {
  ed.dirty = false;
  ed.last = "none";
  return ed;
}
