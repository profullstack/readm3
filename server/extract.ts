/**
 * The text inside an office document or an e-book, for a summary. Word, Excel and
 * PowerPoint (2007+), OpenDocument and EPUB files are zip archives of XML: the archive
 * is read here with no dependency (DecompressionStream inflates), and the XML is cut
 * down to its words. A Word, Excel or PowerPoint 97 file is a compound binary, so its
 * text is recovered as readable runs: enough to summarize, with some stray fragments.
 */

/** The most text one archive may inflate to, so a zip bomb stops early. */
const MAX_INFLATED = 64 * 1024 * 1024;

type Entry = { name: string; method: number; size: number; offset: number };

function entries(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip archive");
  const found = new Map<string, Entry>();
  let at = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let n = 0; n < count && at + 46 <= bytes.length && view.getUint32(at, true) === 0x02014b50; n++) {
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    found.set(name, { name, method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return found;
}

/** A zip archive's files, read on demand as UTF-8 text. */
export class Zip {
  private files: Map<string, Entry>;
  private inflated = 0;
  constructor(private bytes: Uint8Array) { this.files = entries(bytes); }

  names(): string[] { return [...this.files.keys()]; }

  async text(name: string): Promise<string | undefined> {
    const entry = this.files.get(name);
    if (!entry) return undefined;
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (view.getUint32(entry.offset, true) !== 0x04034b50) return undefined;
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    const packed = this.bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return new TextDecoder().decode(packed);
    if (entry.method !== 8) return undefined;
    const reader = new Blob([packed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.inflated += value.length;
      if (this.inflated > MAX_INFLATED) { await reader.cancel(); throw new Error("the archive inflates past 64 MB"); }
      chunks.push(value);
    }
    return new TextDecoder().decode(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** XML (or XHTML) to plain text: the given closing tags break lines, everything else is dropped. */
function words(xml: string, rules: [RegExp, string][]): string {
  // Line breaks between tags are the writer's indentation, not the document's.
  let text = xml.replace(/>\s*\n\s*</g, "><");
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  return decodeEntities(text.replace(/<[^>]*>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const numbered = (names: string[], pattern: RegExp) => names
  .map((name) => ({ name, n: Number(pattern.exec(name)?.[1]) }))
  .filter((item) => Number.isFinite(item.n))
  .sort((a, b) => a.n - b.n);

async function docx(zip: Zip): Promise<string> {
  const parts = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"];
  const texts: string[] = [];
  for (const part of parts) {
    const xml = await zip.text(part);
    if (xml) texts.push(words(xml, [[/<w:tab\/>/g, "\t"], [/<w:(?:br|cr)\b[^>]*\/>/g, "\n"], [/<\/w:p>/g, "\n"]]));
  }
  return texts.filter(Boolean).join("\n\n");
}

async function pptx(zip: Zip): Promise<string> {
  const slides: string[] = [];
  for (const { name, n } of numbered(zip.names(), /^ppt\/slides\/slide(\d+)\.xml$/)) {
    const text = words((await zip.text(name)) ?? "", [[/<a:br\b[^>]*\/>/g, "\n"], [/<\/a:p>/g, "\n"]]);
    const notes = words((await zip.text(`ppt/notesSlides/notesSlide${n}.xml`)) ?? "", [[/<\/a:p>/g, "\n"]]);
    slides.push(`Slide ${n}\n${text}${notes ? `\nNotes: ${notes}` : ""}`);
  }
  return slides.join("\n\n");
}

async function xlsx(zip: Zip): Promise<string> {
  const shared = [...((await zip.text("xl/sharedStrings.xml")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((match) => decodeEntities([...match[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const names = [...((await zip.text("xl/workbook.xml")) ?? "").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => decodeEntities(match[1]!));
  const sheets: string[] = [];
  for (const [index, { name, n }] of numbered(zip.names(), /^xl\/worksheets\/sheet(\d+)\.xml$/).entries()) {
    const xml = (await zip.text(name)) ?? "";
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
      [...row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
        const type = /\bt="([^"]+)"/.exec(cell[1]!)?.[1];
        const inner = cell[2] ?? "";
        if (type === "inlineStr") return decodeEntities([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        const value = decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
        return type === "s" ? shared[Number(value)] ?? "" : value;
      }).join("\t").trimEnd(),
    ).filter(Boolean);
    sheets.push(`Sheet: ${names[index] ?? `Sheet ${n}`}\n${rows.join("\n")}`);
  }
  return sheets.join("\n\n");
}

async function opendocument(zip: Zip): Promise<string> {
  return words((await zip.text("content.xml")) ?? "", [
    [/<text:tab\/>/g, "\t"], [/<text:line-break\/>/g, "\n"], [/<text:s\/>/g, " "],
    [/<\/text:(?:p|h)>/g, "\n"], [/<\/table:table-cell>/g, "\t"], [/<\/table:table-row>/g, "\n"],
    [/<draw:page\b[^>]*\bdraw:name="([^"]*)"[^>]*>/g, "\n\n$1\n"], [/<table:table\b[^>]*\btable:name="([^"]*)"[^>]*>/g, "\n\nSheet: $1\n"],
  ]);
}

const HTML_RULES: [RegExp, string][] = [
  [/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ""],
  [/<br\b[^>]*>/gi, "\n"],
  [/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|pre)>/gi, "\n"],
];

async function epub(zip: Zip): Promise<string> {
  const rootfile = /full-path="([^"]+)"/.exec((await zip.text("META-INF/container.xml")) ?? "")?.[1];
  const opf = rootfile ? (await zip.text(rootfile)) ?? "" : "";
  const base = rootfile?.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map((item) => [/\bid="([^"]+)"/.exec(item[0])?.[1], /\bhref="([^"]+)"/.exec(item[0])?.[1]]));
  let chapters = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)]
    .map((ref) => manifest.get(ref[1]))
    .filter((href): href is string => !!href)
    .map((href) => base + decodeURIComponent(href));
  if (!chapters.length) chapters = zip.names().filter((name) => /\.x?html?$/i.test(name)).sort();
  const texts: string[] = [];
  for (const chapter of chapters) texts.push(words((await zip.text(chapter)) ?? "", HTML_RULES));
  return texts.filter(Boolean).join("\n\n");
}

/**
 * A 97-2003 Office file: runs of readable text, as UTF-16 (how Word and Excel store most
 * strings) and as single-byte text, longest first by position. Short runs are noise.
 */
export function legacyText(bytes: Uint8Array): string {
  const runs: { at: number; text: string }[] = [];
  // Latin, Greek and Cyrillic letters and common punctuation; any other code point in a binary is far likelier noise.
  const readable = (code: number) => code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || (code >= 160 && code < 0x180)
    || (code >= 0x370 && code < 0x500) || (code >= 0x2010 && code < 0x2028) || code === 0x20ac;
  const keep = (at: number, text: string) => {
    const clean = text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
    if (clean.length >= 8 && /[A-Za-zÀ-ɏЀ-ӿ]{3}/.test(clean) && clean.includes(" ")) runs.push({ at, text: clean });
  };
  for (const offset of [0, 1]) {
    let start = -1;
    let text = "";
    for (let i = offset; i + 1 < bytes.length; i += 2) {
      const code = bytes[i]! | (bytes[i + 1]! << 8);
      if (readable(code)) { if (start < 0) start = i; text += String.fromCharCode(code); }
      else { if (start >= 0) keep(start, text); start = -1; text = ""; }
    }
    if (start >= 0) keep(start, text);
  }
  let start = -1;
  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes[i]!;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) { if (start < 0) start = i; text += String.fromCharCode(code); }
    else { if (start >= 0) keep(start, text); start = -1; text = ""; }
  }
  if (start >= 0) keep(start, text);
  const seen = new Set<string>();
  return runs.sort((a, b) => a.at - b.at).filter((run) => !seen.has(run.text) && !!seen.add(run.text)).map((run) => run.text).join("\n");
}

const READERS: Record<string, (zip: Zip) => Promise<string>> = {
  docx, docm: docx, dotx: docx,
  pptx, pptm: pptx, ppsx: pptx,
  xlsx, xlsm: xlsx,
  odt: opendocument, ods: opendocument, odp: opendocument,
  epub,
};

/** Whether `documentText` can read a file with this name. */
export function extractable(path: string): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return extension in READERS || extension === "doc" || extension === "xls" || extension === "ppt";
}

/**
 * The text of an office document or e-book, by its name. `legacy` is true when it was
 * recovered from a 97-2003 file, so the prompt can say it may hold stray fragments.
 */
export async function documentText(path: string, bytes: Uint8Array): Promise<{ text: string; legacy: boolean }> {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const reader = READERS[extension];
  if (reader) return { text: await reader(new Zip(bytes)), legacy: false };
  return { text: legacyText(bytes), legacy: true };
}
