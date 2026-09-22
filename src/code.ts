/**
 * Code pastes: which language a file is, how it is highlighted, and where it folds.
 *
 * A paste used to be Markdown by definition. Now it is whatever was pasted, and this
 * module decides what that is. The file name wins when it carries a known extension;
 * otherwise the content is sniffed (valid JSON, a shebang, an XML or PHP prologue,
 * Markdown structure) and, failing all of those, highlight.js scores the text against
 * the languages registered below. Markdown stays the fallback because a paste with no
 * recognisable syntax is usually prose, and prose reads best through the Markdown
 * renderer.
 *
 * Everything here is pure: no DOM, no database. The server calls it once per paste to
 * store the decision; the viewer calls the highlighting and folding half to draw it.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export interface Language {
  /** The highlight.js grammar name; also what the API reports as `language`. */
  id: string;
  label: string;
  /** Lower-case file extensions, the first one is used when a name has to be invented. */
  extensions: string[];
  mime: string;
  /** False for languages whose grammar scores prose too well to be trusted in auto-detection. */
  auto?: boolean;
}

export const MARKDOWN = "markdown";
export const PLAINTEXT = "plaintext";

export const LANGUAGES: Language[] = [
  { id: "markdown", label: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx"], mime: "text/markdown", auto: false },
  { id: "json", label: "JSON", extensions: ["json", "jsonc", "json5", "geojson", "webmanifest"], mime: "application/json" },
  { id: "javascript", label: "JavaScript", extensions: ["js", "mjs", "cjs", "jsx"], mime: "text/javascript" },
  { id: "typescript", label: "TypeScript", extensions: ["ts", "mts", "cts", "tsx"], mime: "text/typescript" },
  { id: "python", label: "Python", extensions: ["py", "pyi", "pyw"], mime: "text/x-python" },
  { id: "bash", label: "Shell", extensions: ["sh", "bash", "zsh", "fish", "ksh"], mime: "text/x-shellscript" },
  { id: "yaml", label: "YAML", extensions: ["yml", "yaml"], mime: "application/yaml" },
  { id: "xml", label: "HTML / XML", extensions: ["html", "htm", "xml", "svg", "xhtml", "vue", "svelte", "xsl", "plist"], mime: "text/html" },
  { id: "css", label: "CSS", extensions: ["css"], mime: "text/css" },
  { id: "scss", label: "SCSS", extensions: ["scss", "sass"], mime: "text/x-scss" },
  { id: "sql", label: "SQL", extensions: ["sql"], mime: "application/sql" },
  { id: "go", label: "Go", extensions: ["go"], mime: "text/x-go" },
  { id: "rust", label: "Rust", extensions: ["rs"], mime: "text/x-rust" },
  { id: "java", label: "Java", extensions: ["java"], mime: "text/x-java" },
  { id: "kotlin", label: "Kotlin", extensions: ["kt", "kts"], mime: "text/x-kotlin" },
  { id: "swift", label: "Swift", extensions: ["swift"], mime: "text/x-swift" },
  { id: "c", label: "C", extensions: ["c", "h"], mime: "text/x-c" },
  { id: "cpp", label: "C++", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], mime: "text/x-c++" },
  { id: "csharp", label: "C#", extensions: ["cs"], mime: "text/x-csharp" },
  { id: "objectivec", label: "Objective-C", extensions: ["m", "mm"], mime: "text/x-objectivec" },
  { id: "php", label: "PHP", extensions: ["php", "phtml"], mime: "application/x-httpd-php" },
  { id: "ruby", label: "Ruby", extensions: ["rb", "rake", "gemspec"], mime: "text/x-ruby" },
  { id: "perl", label: "Perl", extensions: ["pl", "pm"], mime: "text/x-perl" },
  { id: "lua", label: "Lua", extensions: ["lua"], mime: "text/x-lua" },
  { id: "r", label: "R", extensions: ["r"], mime: "text/x-r" },
  { id: "dart", label: "Dart", extensions: ["dart"], mime: "application/dart" },
  { id: "elixir", label: "Elixir", extensions: ["ex", "exs"], mime: "text/x-elixir" },
  { id: "haskell", label: "Haskell", extensions: ["hs"], mime: "text/x-haskell" },
  { id: "scala", label: "Scala", extensions: ["scala", "sc"], mime: "text/x-scala" },
  { id: "powershell", label: "PowerShell", extensions: ["ps1", "psm1"], mime: "text/x-powershell" },
  { id: "ini", label: "INI / TOML", extensions: ["ini", "toml", "cfg", "conf", "properties", "editorconfig"], mime: "text/plain" },
  { id: "dockerfile", label: "Dockerfile", extensions: ["dockerfile"], mime: "text/plain" },
  { id: "makefile", label: "Makefile", extensions: ["mk", "makefile"], mime: "text/plain" },
  { id: "nginx", label: "nginx", extensions: ["nginx", "nginxconf"], mime: "text/plain" },
  { id: "diff", label: "Diff", extensions: ["diff", "patch"], mime: "text/x-diff" },
  { id: "graphql", label: "GraphQL", extensions: ["graphql", "gql"], mime: "application/graphql" },
  { id: "protobuf", label: "Protocol Buffers", extensions: ["proto"], mime: "text/plain" },
  { id: "plaintext", label: "Plain text", extensions: ["txt", "text", "log", "csv", "tsv"], mime: "text/plain", auto: false },
];

const grammars: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, cpp, csharp, css, dart, diff, dockerfile, elixir, go, graphql, haskell, ini, java, javascript, json,
  kotlin, lua, makefile, markdown, nginx, objectivec, perl, php, plaintext, powershell, protobuf, python, r, ruby,
  rust, scala, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, grammar] of Object.entries(grammars)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammar);
hljs.configure({ ignoreUnescapedHTML: true });

const byId = new Map(LANGUAGES.map((language) => [language.id, language]));
const byExtension = new Map<string, Language>();
for (const language of LANGUAGES) for (const extension of language.extensions) byExtension.set(extension, language);
const AUTO_DETECT = LANGUAGES.filter((language) => language.auto !== false).map((language) => language.id);

/**
 * Files the browser shows on its own without any text rendering: a PDF through the
 * built-in viewer, an image through <img>. Their bytes travel as base64 in `source`.
 */
export interface BinaryType { kind: "pdf" | "image"; mime: string; label: string }
const BINARY_TYPES: Record<string, BinaryType> = {
  pdf: { kind: "pdf", mime: "application/pdf", label: "PDF" },
  png: { kind: "image", mime: "image/png", label: "PNG image" },
  jpg: { kind: "image", mime: "image/jpeg", label: "JPEG image" },
  jpeg: { kind: "image", mime: "image/jpeg", label: "JPEG image" },
  gif: { kind: "image", mime: "image/gif", label: "GIF image" },
  webp: { kind: "image", mime: "image/webp", label: "WebP image" },
  avif: { kind: "image", mime: "image/avif", label: "AVIF image" },
  bmp: { kind: "image", mime: "image/bmp", label: "Bitmap image" },
  ico: { kind: "image", mime: "image/x-icon", label: "Icon" },
  svg: { kind: "image", mime: "image/svg+xml", label: "SVG image" },
};

/** The binary type a file name maps to, or undefined for text (which includes unknown names). */
export function binaryType(name: string | null | undefined): BinaryType | undefined {
  return name ? BINARY_TYPES[extensionOf(name)] : undefined;
}

/**
 * Whether text read from a file is really binary: a NUL byte, or a run of control
 * characters, in the first 8 KB. Text in any encoding the browser decoded has neither.
 */
export function looksBinary(text: string): boolean {
  const head = text.slice(0, 8192);
  if (head.includes("\0")) return true;
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const code = head.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12) control++;
    else if (code === 0xfffd) control++;
  }
  return head.length > 0 && control / head.length > 0.05;
}

export function languageOf(id: string | null | undefined): Language {
  return byId.get(id ?? "") ?? byId.get(MARKDOWN)!;
}

/** The lower-case extension of a file name, without the dot, or "" when there is none. */
export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? "";
  if (/^(dockerfile|makefile)$/i.test(base)) return base.toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The language a known extension maps to, or undefined for an unknown or missing one. */
export function languageForName(name: string | null | undefined): Language | undefined {
  return name ? byExtension.get(extensionOf(name)) : undefined;
}

const SHEBANGS: [RegExp, string][] = [
  [/^#!.*\b(?:ba|z|k|da)?sh\b/, "bash"],
  [/^#!.*\bpython[0-9.]*\b/, "python"],
  [/^#!.*\b(?:node|deno|bun)\b/, "javascript"],
  [/^#!.*\bruby\b/, "ruby"],
  [/^#!.*\bperl\b/, "perl"],
  [/^#!.*\bphp\b/, "php"],
  [/^#!.*\bpwsh\b/, "powershell"],
];

function looksLikeJson(source: string): boolean {
  const trimmed = source.trim();
  if (!/^[[{]/.test(trimmed) || !/[\]}]$/.test(trimmed)) return false;
  try { JSON.parse(trimmed); return true; } catch { return false; }
}

/**
 * Markdown is recognised by its structure rather than scored by a grammar, because the
 * highlight.js Markdown grammar rates most prose and most config files alike. A heading
 * on the first line, a fenced block, or a few list, link and heading lines is enough.
 */
function looksLikeMarkdown(source: string): boolean {
  const lines = source.split("\n", 400);
  if (/^#{1,6}\s+\S/.test(lines[0] ?? "")) return true;
  if (/^```|^~~~/m.test(source)) return true;
  let signals = 0;
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line) || /^\s*[-*+]\s+\S/.test(line) || /^\s*\d+\.\s+\S/.test(line)
      || /\[[^\]]+\]\([^)]+\)/.test(line) || /^>\s/.test(line) || /^\s*\|.*\|\s*$/.test(line)) signals++;
  }
  return signals >= 3;
}

/**
 * Tell-tale constructs per language. Each pattern that matches anywhere counts once, so
 * a language needs two different signals before it is believed; one word that prose
 * might contain ("echo", "select") is never enough. The `m` flag makes `^` a line start.
 */
const SIGNALS: Record<string, RegExp[]> = {
  python: [/^\s*def \w+\(.*\):\s*$/m, /^\s*(?:import \w+(?:\.\w+)*|from \w+(?:\.\w+)* import )/m, /^\s*if __name__ == /m, /^\s*class \w+(?:\(.*\))?:\s*$/m, /^\s*(?:elif |except\b|with .+:$)/m, /\bself\./, /^\s*print\(/m, /\bNone\b|\bTrue\b|\bFalse\b/],
  javascript: [/\b(?:const|let|var) \w+ = /, /\)\s*=>\s*[{(\w]/, /\bfunction\s*\w*\s*\(/, /console\.(?:log|error|warn)\(/, /\brequire\(['"]/, /^\s*(?:import|export) .*from ['"]/m, /module\.exports/, /[^=!]===?[^=]/, /^\s*(?:async |export )?function /m],
  typescript: [/:\s*(?:string|number|boolean|void|any|unknown|never)\b/, /^\s*(?:export )?interface \w+/m, /^\s*(?:export )?type \w+(?:<[^>]*>)? = /m, /\bimplements \w+/, /\bas const\b/, /^\s*(?:export )?enum \w+/m, /\b\w+<\w+(?:\[\])?>\(/],
  go: [/^package \w+$/m, /^\s*func (?:\(\w+ \*?\w+\) )?\w+\(/m, /:=/, /^import (?:\(|")/m, /\bfmt\./, /\bnil\b/, /\berr != nil\b/, /^\s*type \w+ struct \{/m],
  rust: [/^\s*(?:pub )?fn \w+/m, /\blet mut\b/, /\b\w+!\(/, /^\s*use \w+::/m, /^\s*impl(?:<.*>)? \w+/m, /\)\s*->\s*[\w<&]/, /&self\b/, /^\s*(?:pub )?struct \w+/m, /Vec<|Option<|Result</],
  java: [/\bpublic (?:static |final |abstract )*(?:class|void|int|String|boolean)\b/, /System\.out\.print/, /^import java\./m, /@Override/, /\bpublic static void main\(/, /\bnew \w+(?:<.*>)?\(/],
  csharp: [/^using System/m, /^\s*namespace \w+/m, /\bConsole\.Write/, /\bpublic (?:class|void|string|int|async)\b/, /\bvar \w+ = new\b/, /\[\w+\]\s*$/m],
  kotlin: [/^\s*fun \w+\(/m, /\bval \w+(?::|\s*=)/, /\bvar \w+:/, /^\s*(?:data )?class \w+\(/m, /\bfun main\(/, /\bprintln\(/],
  swift: [/^\s*func \w+\(/m, /\blet \w+(?::|\s*=)/, /\bvar \w+:/, /^import (?:Foundation|UIKit|SwiftUI)/m, /\bguard let\b/, /^\s*struct \w+: /m],
  ruby: [/^\s*def \w+[!?]?(?:\(.*\))?\s*$/m, /^\s*end\s*$/m, /^\s*puts /m, /\bdo \|\w+\|/, /^\s*require ['"]/m, /\battr_(?:accessor|reader|writer)\b/, /^\s*class \w+(?: < \w+)?\s*$/m, /\.each\b/],
  php: [/<\?php/, /\$\w+\s*=/, /\$\w+->\w+/, /^\s*(?:public |private |protected )?function \w+\(/m, /\becho\s+['"$]/, /^\s*namespace \w+(?:\\\w+)*;/m],
  bash: [/^\s*(?:if \[|fi$|then$|do$|done$|esac$|elif \[)/m, /\$\{\w+\}|\$\w+\b/, /^\s*\w+\(\)\s*\{/m, /^\s*(?:set -[eux]+|export \w+=)/m, /\|\s*(?:grep|awk|sed|xargs|jq|sort)\b/, /^\s*(?:sudo|apt|apt-get|brew|curl|chmod|mkdir|rm|cp|mv|npm|pnpm|bun|cargo|docker) /m, /^\s*echo "/m, /\[\[ .* \]\]/],
  yaml: [/^---\s*$/m, /^\s+- \w/m, /^\w[\w-]*:\s*$/m, /^\s{2,}\w[\w-]*: \S/m],
  css: [/^\s*[.#][\w-]+(?:[:\s>,][^{]*)?\{/m, /^\s*[a-z-]+:\s*[^;{}=]+;\s*$/m, /@(?:media|import|keyframes|font-face)\b/, /\d(?:px|rem|em|vh|vw)\b/, /\b(?:color|margin|padding|display|font-size|background)\s*:/],
  scss: [/^\s*\$[\w-]+:\s*.+;/m, /@(?:mixin|include|extend|use)\b/, /&(?::|\.|-)/, /^\s*[.#]?[\w-]+\s*\{\s*$/m],
  sql: [/\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE (?:TABLE|INDEX)|ALTER TABLE|DROP TABLE)\b/i, /\bFROM \w+/i, /\bWHERE\b/i, /\b(?:LEFT |INNER |OUTER )?JOIN\b/i, /\bGROUP BY\b|\bORDER BY\b/i, /\bVALUES\s*\(/i],
  xml: [/<\/[\w:-]+>/, /<[\w:-]+(?:\s+[\w:-]+="[^"]*")+\s*\/?>/, /<!--/, /<\w+>[^<]*<\/\w+>/, /^\s*<\w/m],
  c: [/^#include <\w+\.h>/m, /\bint main\s*\(/, /\bprintf\(/, /\b(?:size_t|uint\d+_t|int32_t)\b/, /\b\w+\s*\*\s*\w+\s*=/, /\bmalloc\(|\bfree\(/, /\breturn 0;/],
  cpp: [/^#include <(?:iostream|vector|string|map|memory|algorithm)>/m, /\bstd::/, /\bcout\s*<</, /\btemplate\s*</, /^\s*class \w+\s*(?::\s*public)?/m, /\bnullptr\b/, /\bauto \w+ = /],
  ini: [/^\[[\w.-]+\]\s*$/m, /^\w[\w.-]*\s*=\s*.+$/m, /^[;#] /m, /^[A-Z][A-Z0-9_]+=\S/m],
  dockerfile: [/^FROM \S+/m, /^RUN /m, /^(?:CMD|ENTRYPOINT) /m, /^(?:COPY|ADD|WORKDIR|EXPOSE|ENV|ARG) /m],
  makefile: [/^[\w.-]+:(?: [\w. -]*)?$\n\t/m, /\$\([\w@<^]+\)/, /^\.PHONY:/m, /^\t(?:@|\$\(|[a-z])/m],
  lua: [/^\s*local \w+/m, /^\s*(?:local )?function \w+[.:]?\w*\(/m, /\bthen\s*$/m, /^\s*end\s*$/m, /~=/, /\bnil\b/],
  graphql: [/^\s*(?:type|input|enum|interface) \w+ (?:implements \w+ )?\{/m, /^\s*(?:query|mutation|subscription) \w*/m, /\[\w+!?\]!?/, /^\s*\w+(?:\(.*\))?: \w+!?\s*$/m],
  protobuf: [/^syntax = "proto\d";/m, /^\s*message \w+ \{/m, /^\s*(?:repeated |optional )?\w+ \w+ = \d+;/m, /^\s*(?:service|rpc) \w+/m],
  diff: [/^diff --git /m, /^--- a\//m, /^\+\+\+ b\//m, /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m],
};

/** Scores each language by how many of its signals appear, ignoring nothing but blank lines. */
export function scoreSignals(source: string): { language: string; score: number }[] {
  const sample = source.length > 60000 ? source.slice(0, 60000) : source;
  const scores = Object.entries(SIGNALS).map(([language, patterns]) => ({
    language,
    score: patterns.reduce((sum, pattern) => sum + (pattern.test(sample) ? 1 : 0), 0),
  }));
  // TypeScript is JavaScript plus types: its own signals only count on top of JavaScript's.
  const javascript = scores.find((entry) => entry.language === "javascript")!;
  const typescript = scores.find((entry) => entry.language === "typescript")!;
  typescript.score = typescript.score ? typescript.score + javascript.score : 0;
  // C++ is C plus its own constructs, in the same way.
  const c = scores.find((entry) => entry.language === "c")!;
  const cpp = scores.find((entry) => entry.language === "cpp")!;
  cpp.score = cpp.score ? cpp.score + c.score : 0;
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/** Content sniffing on its own: the extension-free half of {@link detectLanguage}. */
export function sniffLanguage(source: string): string {
  const head = source.slice(0, 200);
  for (const [pattern, id] of SHEBANGS) if (pattern.test(head)) return id;
  if (looksLikeJson(source)) return "json";
  if (/^\s*<\?php\b/.test(head)) return "php";
  if (/^\s*<\?xml\b/.test(head) || /^\s*<!doctype html\b|^\s*<html\b/i.test(head)) return "xml";
  if (/^diff --git |^--- a\/.*\n\+\+\+ b\//m.test(head) || /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(source)) return "diff";
  if (looksLikeMarkdown(source)) return MARKDOWN;
  const [best, second] = scoreSignals(source);
  if (best && best.score >= 2 && best.score > (second?.score ?? 0)) return best.language;
  // The grammar scorer only decides when the signals could not, and only when it is sure.
  // It sees the first few KB only, and nothing with a huge single token: several grammars
  // go quadratic on one (a 16 KB run of one letter takes 13 s), and code never has one.
  const sample = source.slice(0, 4096);
  if (/\w{300,}/.test(sample)) return MARKDOWN;
  const scored = hljs.highlightAuto(sample, AUTO_DETECT);
  const relevance = scored.relevance ?? 0;
  const runnerUp = scored.secondBest?.relevance ?? 0;
  if (scored.language && relevance >= 10 && relevance >= runnerUp + 4) return scored.language;
  return MARKDOWN;
}

/** The language of a paste: the file name when it carries a known extension, else the content. */
export function detectLanguage(name: string | null | undefined, source: string): string {
  return languageForName(name)?.id ?? sniffLanguage(source);
}

/**
 * The text as it should be read. Minified JSON is pretty-printed, because a one-line
 * document cannot be folded or scanned; anything else is shown exactly as pasted.
 */
export function formatForReading(language: string, source: string): { text: string; formatted: boolean } {
  if (language === "json" && !/\n.*\n/.test(source.trim())) {
    try { return { text: JSON.stringify(JSON.parse(source), null, 2), formatted: true }; } catch { /* Not JSON after all; show as is. */ }
  }
  return { text: source, formatted: false };
}

/**
 * Highlights the whole text, then splits it into one HTML string per line with every
 * span balanced, so lines can be laid out, numbered and hidden independently. A token
 * that spans lines (a block comment, a template string) is reopened on each of them.
 */
export function highlightLines(source: string, language: string): string[] {
  // A single token of thousands of characters, or a line past 100 KB, is not code a
  // grammar can walk in reasonable time; such a file is shown plain rather than hanging.
  const pathological = /\w{1000,}/.test(source) || /[^\n]{100000,}/.test(source);
  const grammar = !pathological && hljs.getLanguage(language) ? language : PLAINTEXT;
  const html = hljs.highlight(source, { language: grammar, ignoreIllegals: true }).value;
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  const tokens = html.matchAll(/(<span class="[^"]*">)|(<\/span>)|(\n)|([^<\n]+)/g);
  for (const token of tokens) {
    if (token[1]) { open.push(token[1]); line += token[1]; }
    else if (token[2]) { open.pop(); line += "</span>"; }
    else if (token[3]) { lines.push(line + "</span>".repeat(open.length)); line = open.join(""); }
    else line += token[4];
  }
  lines.push(line + "</span>".repeat(open.length));
  return lines;
}

export interface FoldRegion { start: number; end: number; }

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

/**
 * Where the text folds, by indentation: a line opens a region when the next non-blank
 * line is indented deeper, and the region runs until indentation returns to the opening
 * line's level. A closing bracket on that returning line is folded in too, so `{` folds
 * to `{ … }` the way an editor does. Works for JSON, YAML, Python and every brace
 * language without knowing any of them. Regions are returned in line order.
 */
export function foldRegions(lines: string[]): FoldRegion[] {
  const regions: FoldRegion[] = [];
  const indents = lines.map((line) => (line.trim() ? indentOf(line) : -1));
  for (let start = 0; start < lines.length; start++) {
    const indent = indents[start]!;
    if (indent < 0) continue;
    let next = start + 1;
    while (next < lines.length && indents[next]! < 0) next++;
    if (next >= lines.length || indents[next]! <= indent) continue;
    let end = next;
    let cursor = next + 1;
    while (cursor < lines.length && (indents[cursor]! < 0 || indents[cursor]! > indent)) {
      if (indents[cursor]! >= 0) end = cursor;
      cursor++;
    }
    if (cursor < lines.length && indents[cursor] === indent && /^\s*[\]})>]+[,;]?\s*$/.test(lines[cursor]!)) end = cursor;
    regions.push({ start, end });
  }
  return regions;
}
