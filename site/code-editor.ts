import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { bracketMatching, codeFolding, foldAll, foldGutter, foldKeymap, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting, unfoldAll } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { languages } from "@codemirror/language-data";
import { classHighlighter } from "@lezer/highlight";

/**
 * The source editor: CodeMirror with the Sublime basics (line numbers, multiple cursors,
 * find and replace, folding, bracket matching) and nothing else. It is its own chunk, so
 * reading never downloads it, and each language's grammar is a further chunk loaded the
 * first time a file of that kind is edited. Colors are `tok-*` classes styled from the
 * theme variables, so every readm3 theme applies without editor-specific code.
 */
export interface SourceEditor {
  readonly view: EditorView;
  /** Replaces the text and the language; the undo history starts over, as it does per file. */
  load(text: string, path: string, languageId?: string): void;
  text(): string;
  focus(): void;
  setWrap(on: boolean): void;
  foldAll(): void;
  unfoldAll(): void;
  find(): void;
}

/** Aliases where readm3's language ids (src/code.ts) are not CodeMirror's names. */
const ALIASES: Record<string, string> = { bash: "shell", xml: "html", ini: "toml", makefile: "cmake", objectivec: "objective-c", csharp: "c#", plaintext: "" };

function describe(path: string, languageId?: string): LanguageDescription | null {
  const byName = LanguageDescription.matchFilename(languages, path.split("/").at(-1)!);
  if (byName) return byName;
  const name = languageId === undefined ? "" : ALIASES[languageId] ?? languageId;
  return name ? LanguageDescription.matchLanguageName(languages, name, false) : null;
}

export function createEditor(parent: HTMLElement, onChange: (text: string) => void): SourceEditor {
  const language = new Compartment();
  const wrap = new Compartment();
  let generation = 0;
  let silent = false;
  let wrapped = false;
  const extensions = (): Extension[] => [
    lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), codeFolding(),
    drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true), indentOnInput(),
    syntaxHighlighting(classHighlighter), bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(),
    highlightActiveLine(), highlightSelectionMatches(), search({ top: true }), indentUnit.of("  "),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
    language.of([]), wrap.of(wrapped ? EditorView.lineWrapping : []),
    EditorView.contentAttributes.of({ "aria-label": "File source", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
    EditorView.updateListener.of((update) => { if (update.docChanged && !silent) onChange(update.state.doc.toString()); }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ extensions: extensions() }) });
  return {
    view,
    load(text, path, languageId) {
      const token = ++generation;
      silent = true;
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      silent = false;
      const description = describe(path, languageId);
      if (!description) return;
      // A grammar that is already loaded applies at once; otherwise it arrives a moment later.
      void description.load().then((support) => {
        if (token === generation) view.dispatch({ effects: language.reconfigure(support) });
      }).catch(() => { /* Offline before this grammar was cached: the file stays plain text. */ });
    },
    text: () => view.state.doc.toString(),
    focus: () => view.focus(),
    setWrap: (on) => { wrapped = on; view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) }); },
    foldAll: () => { foldAll(view); },
    unfoldAll: () => { unfoldAll(view); },
    find: () => { openSearchPanel(view); },
  };
}
