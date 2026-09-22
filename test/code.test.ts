import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { binaryType, detectLanguage, extensionOf, foldRegions, formatForReading, highlightLines, languageForName, languageOf, looksBinary, sniffLanguage } from "../src/code.ts";

describe("binary files", () => {
  test("PDFs and images are browser-viewed binaries, everything else is text", () => {
    assert.equal(binaryType("spec.pdf")?.kind, "pdf");
    assert.equal(binaryType("a/b/Photo.JPG")?.mime, "image/jpeg");
    assert.equal(binaryType("logo.svg")?.kind, "image");
    assert.equal(binaryType("config.json"), undefined);
    assert.equal(binaryType("deploy"), undefined);
    assert.equal(binaryType(undefined), undefined);
  });

  test("text that decoded from bytes is caught by NULs or control runs", () => {
    assert.equal(looksBinary("hello\nworld\t!\r\n"), false);
    assert.equal(looksBinary(""), false);
    assert.equal(looksBinary("abc\0def"), true);
    assert.equal(looksBinary("\x01\x02\x03\x04\x05abcdefghij"), true);
    assert.equal(looksBinary("�����abcdefghij"), true);
    assert.equal(looksBinary("only one \x01 in a long line of ordinary text " + "x".repeat(100)), false);
  });
});

describe("language detection", () => {
  test("a known extension wins over the content", () => {
    assert.equal(detectLanguage("notes.md", '{"a":1}'), "markdown");
    assert.equal(detectLanguage("app.json", "# heading"), "json");
    assert.equal(detectLanguage("Component.tsx", "x"), "typescript");
    assert.equal(detectLanguage("Dockerfile", "x"), "dockerfile");
    assert.equal(detectLanguage("deploy/Makefile", "x"), "makefile");
    assert.equal(detectLanguage("index.HTML", "x"), "xml");
  });

  test("an unknown or missing extension sniffs the content", () => {
    assert.equal(detectLanguage("config", "[server]\nport = 8080\nhost = 0.0.0.0\n"), "ini");
    assert.equal(detectLanguage("thing.weird", "# A title\n\nProse.\n"), "markdown");
    assert.equal(detectLanguage(undefined, '{"a":1,"b":[1,2,{"c":null}]}'), "json");
  });

  test("sniffs the usual suspects from their content", () => {
    const cases: [string, string][] = [
      ["json", '[{"id": 1}, {"id": 2}]'],
      ["javascript", "const x = 1;\nfunction hello(name) {\n  return `hi ${name}`;\n}\nexport default hello;\n"],
      ["typescript", "export interface User { id: string; name: string }\nexport function greet(user: User): string {\n  return user.name;\n}\n"],
      ["python", "import os\n\ndef main():\n    print(os.getcwd())\n\nif __name__ == '__main__':\n    main()\n"],
      ["bash", "#!/usr/bin/env bash\nset -e\necho hi\n"],
      ["bash", "set -euo pipefail\nfor f in *.txt; do\n  echo \"$f\"\ndone\n"],
      ["yaml", "name: app\nservices:\n  web:\n    image: nginx\n    ports:\n      - \"80:80\"\n"],
      ["css", ".card {\n  padding: 12px;\n  border-radius: 6px;\n}\n"],
      ["go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n"],
      ["rust", "fn main() {\n    let mut x: i32 = 5;\n    println!(\"{}\", x);\n}\n"],
      ["sql", "SELECT id, name FROM users WHERE created_at > now() ORDER BY id;\n"],
      ["xml", "<!doctype html>\n<html><body><h1>x</h1></body></html>\n"],
      ["xml", "<div class=\"x\"><p>hello</p></div>\n"],
      ["php", "<?php\necho 'hi';\n"],
      ["diff", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n"],
      ["java", "public class Main {\n  public static void main(String[] args) {\n    System.out.println(\"hi\");\n  }\n}\n"],
      ["dockerfile", "FROM node:22\nWORKDIR /app\nRUN npm ci\nCMD [\"node\", \"index.js\"]\n"],
      ["ruby", "class Dog\n  def bark\n    puts 'woof'\n  end\nend\n"],
      ["c", "#include <stdio.h>\n\nint main(void) {\n    printf(\"hi\\n\");\n    return 0;\n}\n"],
      ["cpp", "#include <iostream>\n\nint main() {\n    std::cout << \"hi\";\n    return 0;\n}\n"],
      ["ini", "DATABASE_URL=postgres://x\nPORT=3000\nDEBUG=true\n"],
    ];
    for (const [expected, source] of cases) assert.equal(sniffLanguage(source), expected, source);
  });

  test("prose, lists and notes stay Markdown", () => {
    const prose = [
      "Hello there. This is just a note about the meeting tomorrow. Bring the laptop.\n",
      "Shopping list\nmilk\neggs\nbread and butter\ncall the dentist on Tuesday\n",
      "Then we select the best option and echo it back to the team. If none fits, we end the meeting.\n",
      "Meeting notes\nAttendees: Ann, Bob\nDecision: ship on Friday\nNext: write the blog post\n",
      "# Title\n\nSome prose here.\n\n- one\n- two\n",
      "TypeError: Cannot read properties of undefined\n    at foo (/app/src/a.js:10:5)\n",
    ];
    for (const source of prose) assert.equal(sniffLanguage(source), "markdown", source);
  });

  test("names and extensions round-trip", () => {
    assert.equal(extensionOf("a/b/notes.MD"), "md");
    assert.equal(extensionOf("Dockerfile"), "dockerfile");
    assert.equal(extensionOf(".env"), "");
    assert.equal(extensionOf("noext"), "");
    assert.equal(languageForName("x.py")?.id, "python");
    assert.equal(languageForName("x.unknown"), undefined);
    assert.equal(languageOf("nope").id, "markdown");
    assert.equal(languageOf("json").mime, "application/json");
  });
});

describe("reading format", () => {
  test("pretty-prints minified JSON and leaves everything else alone", () => {
    assert.deepEqual(formatForReading("json", '{"a":1,"b":[1,2]}'), { text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}', formatted: true });
    const pretty = '{\n  "a": 1\n}\n';
    assert.deepEqual(formatForReading("json", pretty), { text: pretty, formatted: false });
    assert.deepEqual(formatForReading("json", "{not json"), { text: "{not json", formatted: false });
    assert.deepEqual(formatForReading("javascript", "x=1"), { text: "x=1", formatted: false });
  });
});

describe("highlighting", () => {
  test("gives one balanced HTML line per source line, reopening spans that cross lines", () => {
    const lines = highlightLines("/* multi\nline */ const a = {\n  b: 1,\n};", "javascript");
    assert.equal(lines.length, 4);
    for (const line of lines) {
      const opens = (line.match(/<span/g) ?? []).length;
      const closes = (line.match(/<\/span>/g) ?? []).length;
      assert.equal(opens, closes, line);
    }
    assert.match(lines[0]!, /hljs-comment/);
    assert.match(lines[1]!, /hljs-comment.*hljs-keyword/);
    assert.match(lines[2]!, /hljs-attr/);
  });

  test("escapes source HTML and falls back to plain text for an unknown grammar", () => {
    const [line] = highlightLines("<script>alert(1)</script>", "nope");
    assert.equal(line, "&lt;script&gt;alert(1)&lt;/script&gt;");
    assert.equal(highlightLines("", "json").length, 1);
  });
});

describe("folding", () => {
  test("folds by indentation and swallows the closing bracket", () => {
    const lines = ['{', '  "a": {', '    "b": 1', '  },', '  "c": [', '    1', '  ]', '}'];
    assert.deepEqual(foldRegions(lines), [{ start: 0, end: 7 }, { start: 1, end: 3 }, { start: 4, end: 6 }]);
  });

  test("folds Python blocks and ignores blank lines at the edges", () => {
    const lines = ["def main():", "    x = 1", "", "    return x", "", "main()"];
    assert.deepEqual(foldRegions(lines), [{ start: 0, end: 3 }]);
  });

  test("treats a tab as four columns and leaves flat text alone", () => {
    assert.deepEqual(foldRegions(["a:", "\tb", "c"]), [{ start: 0, end: 1 }]);
    assert.deepEqual(foldRegions(["one", "two", "three"]), []);
    assert.deepEqual(foldRegions([]), []);
  });
});
