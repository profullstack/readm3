import test from "node:test";
import assert from "node:assert/strict";
import {
  backspace,
  breakRun,
  continuation,
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
  moveWordLeft,
  moveWordRight,
  newline,
  redo,
  text,
  undo,
  type Editor,
} from "../src/editor.ts";

/** An editor with the caret parked at row/col. */
function at(source: string, row: number, col: number): Editor {
  const ed = createEditor(source);
  ed.row = row;
  ed.col = col;
  ed.goal = col;
  return ed;
}

const where = (ed: Editor): [number, number] => [ed.row, ed.col];

test("a buffer round-trips the source it was built from", () => {
  for (const source of ["", "one", "one\ntwo", "trailing\n", "\n\nblanks\n\n"]) {
    assert.equal(text(createEditor(source)), source);
  }
});

/* ---------------------------------------------------------------- edits --- */

test("insert puts text at the caret", () => {
  const ed = at("hello world", 0, 5);
  insert(ed, ",");
  assert.equal(text(ed), "hello, world");
  assert.deepEqual(where(ed), [0, 6]);
});

test("inserting a multi-line string splits the line, so paste works", () => {
  const ed = at("ab", 0, 1);
  insert(ed, "1\n2\n3");
  assert.equal(text(ed), "a1\n2\n3b");
  assert.deepEqual(where(ed), [2, 1]);
});

test("backspace joins onto the line above at column zero", () => {
  const ed = at("one\ntwo", 1, 0);
  backspace(ed);
  assert.equal(text(ed), "onetwo");
  assert.deepEqual(where(ed), [0, 3]);
});

test("backspace at the very start does nothing", () => {
  const ed = at("one", 0, 0);
  backspace(ed);
  assert.equal(text(ed), "one");
  assert.equal(ed.dirty, false);
});

test("backspace eats a whole indent level, not one space", () => {
  const ed = at("    deep", 0, 4);
  backspace(ed);
  assert.equal(text(ed), "  deep");
  assert.deepEqual(where(ed), [0, 2]);
});

test("delete joins the next line up when the caret is at the end", () => {
  const ed = at("one\ntwo", 0, 3);
  del(ed);
  assert.equal(text(ed), "onetwo");
  assert.deepEqual(where(ed), [0, 3]);
});

test("delete at the very end does nothing", () => {
  const ed = at("one", 0, 3);
  del(ed);
  assert.equal(text(ed), "one");
  assert.equal(ed.dirty, false);
});

test("kill clears to the end of the line, then joins", () => {
  const ed = at("keep drop\nnext", 0, 4);
  killToLineEnd(ed);
  assert.equal(text(ed), "keep\nnext");
  killToLineEnd(ed);
  assert.equal(text(ed), "keepnext");
});

test("kill to the line start clears what is behind the caret", () => {
  const ed = at("drop keep", 0, 5);
  killToLineStart(ed);
  assert.equal(text(ed), "keep");
  assert.deepEqual(where(ed), [0, 0]);
});

test("indent inserts one two-space level", () => {
  const ed = at("x", 0, 0);
  indent(ed);
  assert.equal(text(ed), "  x");
});

/* -------------------------------------------------------- continuation --- */

test("a new line inherits the indentation above it", () => {
  assert.deepEqual(continuation("    indented text"), { prefix: "    ", clear: false });
});

test("a bullet item continues with the same marker", () => {
  assert.deepEqual(continuation("- first"), { prefix: "- ", clear: false });
  assert.deepEqual(continuation("  * nested"), { prefix: "  * ", clear: false });
});

test("an ordered item continues with the next number", () => {
  assert.deepEqual(continuation("3. third"), { prefix: "4. ", clear: false });
  assert.deepEqual(continuation("9) ninth"), { prefix: "10) ", clear: false });
});

test("a task item continues as an unchecked task", () => {
  assert.deepEqual(continuation("- [x] done"), { prefix: "- [ ] ", clear: false });
});

test("an item with no content ends the list instead of continuing it", () => {
  assert.deepEqual(continuation("- "), { prefix: "", clear: true });
  assert.deepEqual(continuation("2. "), { prefix: "", clear: true });
});

test("enter carries the list marker onto the next line", () => {
  const ed = at("- first", 0, 7);
  newline(ed);
  assert.equal(text(ed), "- first\n- ");
  assert.deepEqual(where(ed), [1, 2], "caret lands after the new marker");
});

test("enter on an empty item ends the list", () => {
  const ed = at("- first\n- ", 1, 2);
  newline(ed);
  assert.equal(text(ed), "- first\n\n");
  assert.deepEqual(where(ed), [2, 0]);
});

test("enter mid-line splits it and keeps the tail", () => {
  const ed = at("onetwo", 0, 3);
  newline(ed);
  assert.equal(text(ed), "one\ntwo");
  assert.deepEqual(where(ed), [1, 0]);
});

test("enter mid-item carries the marker and the rest of the text", () => {
  const ed = at("- one two", 0, 6);
  newline(ed);
  assert.equal(text(ed), "- one \n- two");
});

test("enter numbers the next ordered item", () => {
  const ed = at("1. first", 0, 8);
  newline(ed);
  assert.equal(text(ed), "1. first\n2. ");
});

test("insert() splits verbatim, without continuing a list", () => {
  const ed = at("- first", 0, 7);
  insert(ed, "\n");
  assert.equal(text(ed), "- first\n");
});

/* --------------------------------------------------------------- motion --- */

test("left and right cross the line boundary", () => {
  const ed = at("ab\ncd", 0, 2);
  moveRight(ed);
  assert.deepEqual(where(ed), [1, 0]);
  moveLeft(ed);
  assert.deepEqual(where(ed), [0, 2]);
});

test("vertical motion remembers the column it was aiming for", () => {
  const ed = at("long line here\nx\nlong line here", 0, 12);
  moveDown(ed);
  assert.deepEqual(where(ed), [1, 1], "clamped to the short line");
  moveDown(ed);
  assert.deepEqual(where(ed), [2, 12], "and back out to the goal");
});

test("home goes to the first non-blank, then to column zero", () => {
  const ed = at("    text", 0, 8);
  moveHome(ed);
  assert.deepEqual(where(ed), [0, 4]);
  moveHome(ed);
  assert.deepEqual(where(ed), [0, 0]);
});

test("end, document start and document end", () => {
  const ed = at("one\ntwo three", 0, 0);
  moveEnd(ed);
  assert.deepEqual(where(ed), [0, 3]);
  moveDocEnd(ed);
  assert.deepEqual(where(ed), [1, 9]);
  moveDocStart(ed);
  assert.deepEqual(where(ed), [0, 0]);
});

test("word motion steps over punctuation to the next word", () => {
  const ed = at("alpha beta, gamma", 0, 0);
  moveWordRight(ed);
  assert.equal(ed.col, 6);
  moveWordRight(ed);
  assert.equal(ed.col, 12);
  moveWordLeft(ed);
  assert.equal(ed.col, 6);
  moveWordLeft(ed);
  assert.equal(ed.col, 0);
});

test("motion past the last line stops at the last line", () => {
  const ed = at("one\ntwo", 0, 0);
  moveDown(ed);
  moveDown(ed);
  moveDown(ed);
  assert.equal(ed.row, 1);
  moveUp(ed);
  moveUp(ed);
  assert.equal(ed.row, 0);
});

/* ----------------------------------------------------------------- undo --- */

test("a run of typing undoes as one step", () => {
  const ed = createEditor("");
  insert(ed, "h");
  insert(ed, "i");
  assert.equal(text(ed), "hi");
  undo(ed);
  assert.equal(text(ed), "", "both characters go back together");
});

test("breaking the run splits the undo step", () => {
  const ed = createEditor("");
  insert(ed, "a");
  breakRun(ed);
  insert(ed, "b");
  undo(ed);
  assert.equal(text(ed), "a");
  undo(ed);
  assert.equal(text(ed), "");
});

test("undo restores the caret, not just the text", () => {
  const ed = at("one\ntwo", 1, 3);
  insert(ed, "!");
  undo(ed);
  assert.equal(text(ed), "one\ntwo");
  assert.deepEqual(where(ed), [1, 3]);
});

test("redo replays what undo took back", () => {
  const ed = createEditor("start");
  moveDocEnd(ed);
  insert(ed, "!");
  undo(ed);
  assert.equal(text(ed), "start");
  redo(ed);
  assert.equal(text(ed), "start!");
});

test("an edit after an undo drops the redo stack", () => {
  const ed = createEditor("");
  insert(ed, "a");
  undo(ed);
  insert(ed, "b");
  redo(ed);
  assert.equal(text(ed), "b", "redo has nothing to replay");
});

test("undo on a fresh buffer is a no-op", () => {
  const ed = createEditor("x");
  undo(ed);
  assert.equal(text(ed), "x");
});

test("insert and delete are separate undo steps", () => {
  const ed = at("abc", 0, 3);
  insert(ed, "d");
  backspace(ed);
  assert.equal(text(ed), "abc");
  undo(ed);
  assert.equal(text(ed), "abcd", "the delete comes back first");
  undo(ed);
  assert.equal(text(ed), "abc");
});

/* ---------------------------------------------------------------- dirty --- */

test("a buffer is clean until it is edited, and again once saved", () => {
  const ed = createEditor("x");
  assert.equal(ed.dirty, false);
  moveDocEnd(ed);
  assert.equal(ed.dirty, false, "moving the caret is not an edit");
  insert(ed, "y");
  assert.equal(ed.dirty, true);
  markSaved(ed);
  assert.equal(ed.dirty, false);
});
