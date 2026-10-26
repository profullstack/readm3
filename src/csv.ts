/**
 * Tables: CSV, TSV and their cousins, read into rows of strings and viewed as a grid.
 *
 * One module for every surface. The terminal reader draws the result with hqtui's data
 * grid, the web viewer builds a <table> from it, `--print` lays it out as text, and the
 * paste service uses `looksLikeTable` to recognise a pasted CSV. Nothing here touches a
 * DOM, a terminal or a file, so all of it is tested without either.
 *
 * Inspired by tabiew (github.com/shshemi/tabiew): sort by any column, filter rows,
 * open one row as a sheet, and per-column statistics. Querying is a small filter
 * language rather than SQL: `city:london age>30 !draft`.
 */

export const TABLE_LANGUAGE = "csv";

export type Delimiter = "," | "\t" | ";" | "|";
export const DELIMITERS: Delimiter[] = [",", "\t", ";", "|"];
export type ColumnType = "number" | "date" | "boolean" | "text";

export interface Column {
  name: string;
  type: ColumnType;
}

export interface Table {
  delimiter: Delimiter;
  /** Whether the first record was taken as column names. */
  header: boolean;
  columns: Column[];
  /** Data records, every one padded or cut to the column count. */
  rows: string[][];
  /** Records with a different field count than the header (or the widest record), before padding. */
  ragged: number;
}

export interface ParseOptions {
  delimiter?: Delimiter | undefined;
  /** Force a header row on or off; detected when omitted. */
  header?: boolean | undefined;
  /** File name, so `.tsv` means tabs without sniffing. */
  name?: string | undefined;
}

export const TABLE_EXTENSIONS = ["csv", "tsv", "tab", "psv"];
const TABLE_NAME = /\.(?:csv|tsv|tab|psv)$/i;

/** Whether a file name is one the table view opens. */
export function isTableName(name: string | null | undefined): boolean {
  return !!name && TABLE_NAME.test(name);
}

/**
 * RFC 4180 records: quoted fields may hold the delimiter, quotes ("" escapes one) and
 * line breaks; CRLF, LF and lone CR all end a record; a leading BOM is dropped. One
 * pass, no regex per character, so a 4 MB file parses in milliseconds.
 */
export function parseRecords(source: string, delimiter: Delimiter, limit = Infinity): string[][] {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === delimiter) { record.push(field); field = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      if (records.length >= limit) return records;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  // Blank lines are not empty records; a trailing newline is not a last record.
  return records.filter((r) => r.length > 1 || r[0] !== "");
}

/**
 * The delimiter a text uses: the candidate that splits the first lines into the same
 * number of fields (more than one) most consistently. Ties go to the order of
 * DELIMITERS, so a comma wins over a semicolon that merely appears in the data.
 */
export function sniffDelimiter(source: string, name?: string): Delimiter {
  if (name && /\.(?:tsv|tab)$/i.test(name)) return "\t";
  if (name && /\.psv$/i.test(name)) return "|";
  return scoreDelimiters(source)[0]?.delimiter ?? ",";
}

function scoreDelimiters(source: string): { delimiter: Delimiter; fields: number; consistency: number }[] {
  const sample = source.slice(0, 64 * 1024);
  const scored = DELIMITERS.map((delimiter) => {
    const records = parseRecords(sample, delimiter, 50);
    // The last sampled record may be cut off by the sample boundary.
    const usable = sample.length < source.length && records.length > 2 ? records.slice(0, -1) : records;
    const counts = new Map<number, number>();
    for (const record of usable) counts.set(record.length, (counts.get(record.length) ?? 0) + 1);
    let fields = 1;
    let most = 0;
    for (const [count, times] of counts) if (times > most || (times === most && count > fields)) { fields = count; most = times; }
    return { delimiter, fields, consistency: usable.length ? most / usable.length : 0 };
  });
  return scored
    .filter((s) => s.fields > 1)
    // Ties go to more fields (a TSV whose cells each hold one comma), then to DELIMITERS order.
    .sort((a, b) => b.consistency - a.consistency || b.fields - a.fields);
}

/**
 * Whether pasted text with no file name is a table. Strict on purpose, because prose
 * and code have commas too: at least three records, every sampled one with the same
 * field count of two or more, and no line ending the way code does.
 */
export function looksLikeTable(source: string): boolean {
  const lines = source.slice(0, 64 * 1024).split(/\r?\n/).filter((line) => line.trim()).slice(0, 50);
  if (lines.length < 3) return false;
  if (lines.some((line) => /[{};]\s*$|^\s*(?:\/\/|#|--)/.test(line) && !/\t/.test(line))) return false;
  const best = scoreDelimiters(source)[0];
  if (!best || best.consistency < 1) return false;
  // Comma-separated prose ("Hello, world") has long cells full of spaces; data does not.
  if (best.delimiter === ",") {
    const records = parseRecords(source.slice(0, 16 * 1024), ",", 20);
    const wordy = records.flat().filter((cell) => cell.trim().split(/\s+/).length > 6).length;
    if (wordy > records.length) return false;
    // So does a sentence with one comma per line: the text after it starts with a space and a word.
    const later = records.flatMap((record) => record.slice(1));
    if (later.length && later.filter((cell) => /^ [A-Za-z]/.test(cell)).length / later.length >= 0.5) return false;
  }
  return true;
}

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/;
const CURRENCY = /^[-+]?[$€£¥]\s?/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const BOOLEAN = /^(?:true|false|yes|no|y|n|t|f)$/i;

/** A cell as a number, or NaN: thousands commas, a currency sign and a % are allowed. */
export function toNumber(cell: string): number {
  const trimmed = cell.trim().replace(CURRENCY, "");
  if (!trimmed || !/\d/.test(trimmed) || !NUMBER.test(trimmed)) return NaN;
  return Number(trimmed.replace(/,/g, "").replace(/%$/, ""));
}

function typeOfCell(cell: string): ColumnType | null {
  const value = cell.trim();
  if (!value) return null;
  if (!Number.isNaN(toNumber(value))) return "number";
  if (DATE.test(value) && !Number.isNaN(Date.parse(value))) return "date";
  if (BOOLEAN.test(value)) return "boolean";
  return "text";
}

/** A column's type: what at least 95% of its non-empty sampled cells are. */
export function inferType(cells: readonly string[]): ColumnType {
  const counts: Record<ColumnType, number> = { number: 0, date: 0, boolean: 0, text: 0 };
  let seen = 0;
  const step = Math.max(1, Math.floor(cells.length / 2000));
  for (let i = 0; i < cells.length; i += step) {
    const type = typeOfCell(cells[i] ?? "");
    if (!type) continue;
    counts[type]++;
    seen++;
  }
  if (!seen) return "text";
  for (const type of ["number", "date", "boolean"] as const) if (counts[type] / seen >= 0.95) return type;
  return "text";
}

/**
 * Whether the first record names the columns. It does unless it looks like data: a
 * value typed the way the rest of its column is (a number over numbers), a blank, or
 * a repeated name.
 */
export function detectHeader(records: readonly string[][]): boolean {
  const [first, ...rest] = records;
  if (!first || rest.length === 0) return true;
  if (first.some((cell) => !cell.trim())) return false;
  if (new Set(first.map((cell) => cell.trim().toLowerCase())).size !== first.length) return false;
  for (let c = 0; c < first.length; c++) {
    const below = inferType(rest.slice(0, 200).map((record) => record[c] ?? ""));
    if (below !== "text" && typeOfCell(first[c]!) === below) return false;
  }
  return true;
}

/** Spreadsheet column names: A … Z, AA, AB … for a file with no header. */
export function letterName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function parseTable(source: string, options: ParseOptions = {}): Table {
  const delimiter = options.delimiter ?? sniffDelimiter(source, options.name);
  const records = parseRecords(source, delimiter);
  const header = options.header ?? detectHeader(records);
  const head = header ? records[0] ?? [] : [];
  const body = header ? records.slice(1) : records;
  const width = Math.max(head.length, ...body.slice(0, 5000).map((record) => record.length), 0);
  // Ragged means "not the shape the header promised"; with no header, not the widest shape.
  const expected = header ? head.length : width;
  let ragged = 0;
  const rows = body.map((record) => {
    if (record.length !== expected) ragged++;
    if (record.length === width) return record;
    return record.length > width ? record.slice(0, width) : [...record, ...Array<string>(width - record.length).fill("")];
  });
  const columns: Column[] = [];
  for (let c = 0; c < width; c++) {
    const raw = head[c]?.trim();
    columns.push({ name: raw || letterName(c), type: inferType(rows.map((row) => row[c]!)) });
  }
  return { delimiter, header, columns, rows, ragged };
}

export interface Sort {
  column: number;
  descending?: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compares two cells the way their column's type reads; empty cells always sort last. */
export function compareCells(a: string, b: string, type: ColumnType): number {
  const ea = !a.trim();
  const eb = !b.trim();
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (type === "number") {
    const d = toNumber(a) - toNumber(b);
    if (!Number.isNaN(d) && d !== 0) return d;
  } else if (type === "date") {
    const d = Date.parse(a) - Date.parse(b);
    if (!Number.isNaN(d) && d !== 0) return d;
  } else if (type === "boolean") {
    const truthy = (v: string) => (/^(?:true|yes|y|t)$/i.test(v.trim()) ? 1 : 0);
    const d = truthy(b) - truthy(a);
    if (d) return d;
  }
  return collator.compare(a, b);
}

/** One filter term: free text, `col:text`, or `col` with = != > >= < <=. */
export interface FilterTerm {
  column: number | null;
  op: ":" | "=" | "!=" | ">" | ">=" | "<" | "<=";
  value: string;
  negate: boolean;
}

/**
 * Parses a filter. Terms are separated by spaces and must all match. A term is free
 * text (any cell contains it), `column:text` (that column contains it), or a
 * comparison such as `age>30`, `price<=9.99`, `status=open`, `country!=US`. A leading
 * `!` negates. Quotes keep spaces: `city:"new york"`. A column is named, or numbered
 * from 1 (`#3>10`). Unknown column names fall back to free text.
 */
export function parseFilter(query: string, columns: readonly Column[]): FilterTerm[] {
  const terms: FilterTerm[] = [];
  const tokens = query.match(/[^\s"]*"[^"]*"?\S*|\S+/g) ?? [];
  const byName = new Map(columns.map((column, index) => [column.name.toLowerCase(), index]));
  for (let token of tokens) {
    let negate = false;
    if (token.startsWith("!") && token.length > 1) { negate = true; token = token.slice(1); }
    const match = token.match(/^("[^"]+"|#\d+|[^:=!<>]+)(:|!=|>=|<=|=|>|<)(.*)$/);
    const unquote = (s: string) => s.replace(/^"|"$/g, "");
    if (match) {
      const name = unquote(match[1]!).toLowerCase();
      const column = /^#\d+$/.test(name) ? Number(name.slice(1)) - 1 : byName.get(name);
      if (column !== undefined && column >= 0 && column < columns.length) {
        terms.push({ column, op: match[2] as FilterTerm["op"], value: unquote(match[3]!), negate });
        continue;
      }
    }
    terms.push({ column: null, op: ":", value: unquote(token), negate });
  }
  return terms.filter((term) => term.value !== "" || term.op !== ":");
}

function termMatches(row: readonly string[], term: FilterTerm, columns: readonly Column[]): boolean {
  const needle = term.value.toLowerCase();
  if (term.column === null) return row.some((cell) => cell.toLowerCase().includes(needle));
  const cell = row[term.column] ?? "";
  const type = columns[term.column]!.type;
  switch (term.op) {
    case ":":
      return cell.toLowerCase().includes(needle);
    case "=":
      return type === "number" && !Number.isNaN(toNumber(term.value))
        ? toNumber(cell) === toNumber(term.value)
        : cell.trim().toLowerCase() === needle;
    case "!=":
      return type === "number" && !Number.isNaN(toNumber(term.value))
        ? toNumber(cell) !== toNumber(term.value)
        : cell.trim().toLowerCase() !== needle;
    default: {
      if (!cell.trim()) return false;
      // Two numbers compare as numbers whatever the column was typed as.
      const numeric = !Number.isNaN(toNumber(cell)) && !Number.isNaN(toNumber(term.value));
      const order = compareCells(cell, term.value, numeric ? "number" : type);
      return term.op === ">" ? order > 0 : term.op === ">=" ? order >= 0 : term.op === "<" ? order < 0 : order <= 0;
    }
  }
}

/**
 * The rows to show, as indices into `table.rows`: filtered, then sorted. The sort is
 * stable, so sorting by one column and then another keeps ties in the earlier order.
 */
export function viewRows(table: Table, options: { filter?: string; sort?: Sort | null } = {}): number[] {
  const terms = options.filter ? parseFilter(options.filter, table.columns) : [];
  const indices: number[] = [];
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i]!;
    if (terms.every((term) => termMatches(row, term, table.columns) !== term.negate)) indices.push(i);
  }
  const sort = options.sort;
  if (sort && sort.column >= 0 && sort.column < table.columns.length) {
    const type = table.columns[sort.column]!.type;
    const sign = sort.descending ? -1 : 1;
    indices.sort((a, b) => {
      const ca = table.rows[a]![sort.column]!;
      const cb = table.rows[b]![sort.column]!;
      // Empties stay last whichever way the sort runs.
      if (!ca.trim() !== !cb.trim()) return ca.trim() ? -1 : 1;
      return sign * compareCells(ca, cb, type) || a - b;
    });
  }
  return indices;
}

/** The next sort after a click on `column`: ascending, then descending, then none. */
export function nextSort(current: Sort | null | undefined, column: number): Sort | null {
  if (!current || current.column !== column) return { column };
  if (!current.descending) return { column, descending: true };
  return null;
}

export interface ColumnStats {
  name: string;
  type: ColumnType;
  count: number;
  empty: number;
  unique: number;
  min?: string;
  max?: string;
  sum?: number;
  mean?: number;
  median?: number;
  /** The most frequent values, most first, at most five. */
  top: { value: string; count: number }[];
}

/** Statistics for one column over the given rows (the filtered view, by default all). */
export function columnStats(table: Table, column: number, indices?: readonly number[]): ColumnStats {
  const info = table.columns[column]!;
  const rows = indices ?? table.rows.map((_, i) => i);
  const counts = new Map<string, number>();
  const values: string[] = [];
  let empty = 0;
  for (const index of rows) {
    const cell = table.rows[index]![column] ?? "";
    if (!cell.trim()) { empty++; continue; }
    values.push(cell);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).slice(0, 5).map(([value, count]) => ({ value, count }));
  const stats: ColumnStats = { name: info.name, type: info.type, count: rows.length, empty, unique: counts.size, top };
  if (!values.length) return stats;
  const sorted = [...values].sort((a, b) => compareCells(a, b, info.type));
  stats.min = sorted[0];
  stats.max = sorted.at(-1);
  if (info.type === "number") {
    const numbers = values.map(toNumber).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    if (numbers.length) {
      stats.sum = numbers.reduce((total, n) => total + n, 0);
      stats.mean = stats.sum / numbers.length;
      const mid = numbers.length >> 1;
      stats.median = numbers.length % 2 ? numbers[mid] : (numbers[mid - 1]! + numbers[mid]!) / 2;
    }
  }
  return stats;
}

/** A number as people read it: grouped, at most four decimals. */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Stats as label/value pairs, for a dialog or a modal. */
export function statsRows(stats: ColumnStats): { label: string; value: string }[] {
  const rows = [
    { label: "type", value: stats.type },
    { label: "rows", value: formatNumber(stats.count) },
    { label: "empty", value: formatNumber(stats.empty) },
    { label: "distinct", value: formatNumber(stats.unique) },
  ];
  if (stats.min !== undefined) rows.push({ label: "min", value: stats.min });
  if (stats.max !== undefined) rows.push({ label: "max", value: stats.max });
  if (stats.sum !== undefined) rows.push({ label: "sum", value: formatNumber(stats.sum) });
  if (stats.mean !== undefined) rows.push({ label: "mean", value: formatNumber(stats.mean) });
  if (stats.median !== undefined) rows.push({ label: "median", value: formatNumber(stats.median) });
  for (const { value, count } of stats.top) rows.push({ label: `× ${formatNumber(count)}`, value });
  return rows;
}

/** The delimiter as people name it. */
export function delimiterName(delimiter: Delimiter): string {
  return delimiter === "," ? "comma" : delimiter === "\t" ? "tab" : delimiter === ";" ? "semicolon" : "pipe";
}

/** A field written back out, quoted only when it has to be. */
export function quoteField(cell: string, delimiter: Delimiter): string {
  return cell.includes(delimiter) || /["\r\n]/.test(cell) || /^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** The view (filtered, sorted) back as delimited text, header first. */
export function toDelimited(table: Table, indices: readonly number[], delimiter: Delimiter = table.delimiter): string {
  const line = (cells: readonly string[]) => cells.map((cell) => quoteField(cell, delimiter)).join(delimiter);
  const out = [line(table.columns.map((column) => column.name)), ...indices.map((index) => line(table.rows[index]!))];
  return `${out.join("\n")}\n`;
}

/** A cell for one line of a fixed-width layout: first line only, tabs as spaces. */
export function displayCell(cell: string): string {
  const at = cell.search(/[\r\n]/);
  return (at < 0 ? cell : `${cell.slice(0, at)}↵`).replace(/\t/g, " ");
}

/** Numbers and dates read right-aligned, the way a spreadsheet shows them. */
export function alignOf(type: ColumnType): "left" | "right" {
  return type === "number" ? "right" : "left";
}

/**
 * The table as a GFM pipe table, every cell escaped so nothing in the data turns into
 * formatting. `--print` renders a CSV through this, so it shares the Markdown
 * renderer's column fitting instead of growing a second one.
 */
export function toMarkdownTable(table: Table, indices: readonly number[] = table.rows.map((_, i) => i)): string {
  const escape = (cell: string) => displayCell(cell).replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, "\\$&") || " ";
  const line = (cells: readonly string[]) => `| ${cells.map(escape).join(" | ")} |`;
  const rule = `|${table.columns.map((column) => (alignOf(column.type) === "right" ? " ---: " : " --- ")).join("|")}|`;
  return [line(table.columns.map((column) => column.name)), rule, ...indices.map((index) => line(table.rows[index]!))].join("\n") + "\n";
}

export interface TableQuery {
  filter?: string | undefined;
  /** A column name, or its 1-based number. */
  sort?: string | number | undefined;
  descending?: boolean | undefined;
  /** Rows to return, at most 1,000. Default 50. */
  limit?: number | undefined;
  offset?: number | undefined;
  /** A column to summarise, by name or 1-based number. */
  stats?: string | number | undefined;
  name?: string | undefined;
}

/** A column by name (case-insensitive) or 1-based number, or -1. */
export function columnIndex(table: Table, ref: string | number | undefined): number {
  if (ref === undefined || ref === "") return -1;
  if (typeof ref === "number" || /^#?\d+$/.test(ref)) {
    const n = Number(String(ref).replace("#", "")) - 1;
    return n >= 0 && n < table.columns.length ? n : -1;
  }
  return table.columns.findIndex((column) => column.name.toLowerCase() === ref.toLowerCase());
}

/**
 * One call's worth of a table for an agent: the typed columns, the rows that match,
 * sorted and paged, as objects keyed by column name, and optionally one column's
 * statistics over the matching rows. What the MCP `table_query` tool returns.
 */
export function queryTable(source: string, query: TableQuery = {}) {
  const table = parseTable(source, { name: query.name });
  const sortColumn = columnIndex(table, query.sort);
  if (query.sort !== undefined && sortColumn < 0) throw new Error(`No column ${JSON.stringify(query.sort)}. Columns: ${table.columns.map((c) => c.name).join(", ")}`);
  const indices = viewRows(table, { filter: query.filter, sort: sortColumn >= 0 ? { column: sortColumn, descending: query.descending } : null });
  const limit = Math.max(0, Math.min(1000, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const statsColumn = columnIndex(table, query.stats);
  if (query.stats !== undefined && statsColumn < 0) throw new Error(`No column ${JSON.stringify(query.stats)}.`);
  return {
    delimiter: delimiterName(table.delimiter),
    header: table.header,
    columns: table.columns,
    total: table.rows.length,
    matched: indices.length,
    offset,
    rows: indices.slice(offset, offset + limit).map((index): Record<string, string | number> => ({
      row: index + 1,
      ...Object.fromEntries(table.columns.map((column, c) => [column.name, table.rows[index]![c] ?? ""])),
    })),
    ...(statsColumn >= 0 ? { stats: columnStats(table, statsColumn, indices) } : {}),
  };
}
