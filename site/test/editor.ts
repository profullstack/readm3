import type { Page } from "@playwright/test";

/** The editable surface of the CodeMirror editor; `fill` replaces the whole file. */
export const editorInput = (page: Page) => page.locator("#editor .cm-content");

/** The text in the editor, one `.cm-line` per line (the files under test are short enough to be fully rendered). */
export const editorText = (page: Page) =>
  editorInput(page).evaluate((element) => [...element.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n"));
