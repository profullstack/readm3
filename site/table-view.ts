/**
 * The table view: a CSV or TSV drawn as a grid instead of as text. Parsing, sorting,
 * filtering and statistics come from src/csv.ts, the same code the terminal reader
 * uses, so `age>30` filters the same rows in both. This file only owns the DOM.
 *
 * Rows are added 500 at a time: a 4 MB file is ~50,000 rows, and building them all
 * up front would freeze the page for a table nobody scrolls to the end of. Sort and
 * filter run over every row, so what is shown first is always the right 500.
 */
import { alignOf, columnStats, delimiterName, displayCell, nextSort, parseTable, statsRows, toDelimited, viewRows, type Sort, type Table } from "../src/csv.ts";

export interface TableView {
  table: Table;
  /** The rows shown, as indices into `table.rows`. */
  shown(): number[];
  /** The shown rows as delimited text, header first. */
  text(): string;
}

export interface TableActions {
  /** Hands text to the clipboard, with a confirmation. */
  copy(text: string): void;
  /** Saves text as a file. */
  save(text: string, name: string): void;
}

const PAGE = 500;
const TYPE_MARK = { number: "123", date: "date", boolean: "y/n", text: "abc" } as const;

/** Filter and sort per file, so switching away and back keeps them. */
const remembered = new Map<string, { filter: string; sort: Sort | null }>();

let dialog: HTMLDialogElement | null = null;
function sheetDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "table-dialog";
  dialog.setAttribute("aria-labelledby", "table-dialog-title");
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog!.close(); });
  document.body.append(dialog);
  return dialog;
}

function showPairs(title: string, pairs: { label: string; value: string }[], note?: string) {
  const box = sheetDialog();
  const form = document.createElement("form");
  form.method = "dialog";
  const header = document.createElement("div");
  header.className = "dialog-header";
  const heading = document.createElement("h2");
  heading.id = "table-dialog-title";
  heading.textContent = title;
  const close = document.createElement("button");
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  header.append(heading, close);
  const list = document.createElement("dl");
  list.className = "sheet-list";
  for (const { label, value } of pairs) {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    if (!value) detail.className = "empty";
    list.append(term, detail);
  }
  form.append(header, list);
  if (note) {
    const p = document.createElement("p");
    p.textContent = note;
    form.append(p);
  }
  box.replaceChildren(form);
  box.showModal();
}

export function renderTable(container: HTMLElement, source: string, path: string, actions: TableActions): TableView {
  const table = parseTable(source, { name: path });
  const state = remembered.get(path) ?? { filter: "", sort: null };
  remembered.set(path, state);
  let shown = viewRows(table, state);
  let drawn = 0;

  container.replaceChildren();
  container.dataset.language = "csv";
  container.classList.add("table-view");

  const tools = document.createElement("div");
  tools.className = "table-tools";
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "table-filter";
  filter.placeholder = "Filter rows: text, city:london, age>30, !draft";
  filter.setAttribute("aria-label", "Filter rows");
  filter.value = state.filter;
  const count = document.createElement("span");
  count.className = "table-count";
  count.setAttribute("aria-live", "polite");
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy view";
  copyButton.title = "Copy the rows shown, sorted and filtered, as CSV";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.textContent = "Download view";
  saveButton.title = "Download the rows shown, sorted and filtered, as a file";
  tools.append(filter, count, copyButton, saveButton);

  const grid = document.createElement("table");
  grid.className = "data-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "rownum";
  corner.textContent = "#";
  headRow.append(corner);
  const sortButtons: HTMLButtonElement[] = [];
  table.columns.forEach((column, index) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = alignOf(column.type) === "right" ? "num" : "";
    const sort = document.createElement("button");
    sort.type = "button";
    sort.className = "column-sort";
    sort.title = `Sort by ${column.name}`;
    sort.addEventListener("click", () => {
      state.sort = nextSort(state.sort, index);
      refresh();
    });
    sortButtons.push(sort);
    const stats = document.createElement("button");
    stats.type = "button";
    stats.className = "column-stats";
    stats.textContent = "Σ";
    stats.title = `Statistics for ${column.name}`;
    stats.setAttribute("aria-label", `Statistics for ${column.name}`);
    stats.addEventListener("click", () => {
      showPairs(column.name, statsRows(columnStats(table, index, shown)), state.filter ? "Over the filtered rows." : undefined);
    });
    th.append(sort, stats);
    headRow.append(th);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  grid.append(head, body);
  const scroller = document.createElement("div");
  scroller.className = "table-scroll";
  scroller.append(grid);

  const more = document.createElement("button");
  more.type = "button";
  more.className = "table-more";
  more.addEventListener("click", () => drawMore());

  const note = document.createElement("p");
  note.className = "media-note";
  const notes = [`${table.header ? "First row is the header" : "No header row; columns are lettered"} · ${delimiterName(table.delimiter)}-separated`];
  if (table.ragged) notes.push(`${table.ragged.toLocaleString()} row${table.ragged === 1 ? " has" : "s have"} a different number of fields than the header`);
  note.textContent = `${notes.join(" · ")}. Click a row to see it whole; Edit changes the text.`;

  container.append(tools, scroller, more, note);

  body.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest("tr");
    if (!row?.dataset.index) return;
    openSheet(Number(row.dataset.index));
  });
  body.addEventListener("keydown", (event) => {
    const row = (event.target as HTMLElement).closest("tr");
    if (event.key === "Enter" && row?.dataset.index) openSheet(Number(row.dataset.index));
  });

  function openSheet(index: number) {
    const record = table.rows[index]!;
    showPairs(`Row ${(index + 1).toLocaleString()}`, table.columns.map((column, c) => ({ label: column.name, value: record[c] ?? "" })));
  }

  let typing: ReturnType<typeof setTimeout> | undefined;
  filter.addEventListener("input", () => {
    clearTimeout(typing);
    // A keystroke on a 50,000-row file re-filters everything; wait for a pause.
    typing = setTimeout(() => { state.filter = filter.value; refresh(); }, table.rows.length > 20000 ? 200 : 60);
  });
  filter.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && filter.value) { event.stopPropagation(); filter.value = ""; state.filter = ""; refresh(); }
  });
  copyButton.addEventListener("click", () => actions.copy(toDelimited(table, shown)));
  saveButton.addEventListener("click", () => {
    const base = path.split("/").at(-1)!.replace(/\.[^.]+$/, "");
    const extension = table.delimiter === "\t" ? "tsv" : "csv";
    actions.save(toDelimited(table, shown, table.delimiter === "\t" ? "\t" : ","), `${base}${state.filter || state.sort ? "-view" : ""}.${extension}`);
  });

  function drawMore() {
    const fragment = document.createDocumentFragment();
    const end = Math.min(shown.length, drawn + PAGE);
    for (let position = drawn; position < end; position++) {
      const index = shown[position]!;
      const record = table.rows[index]!;
      const tr = document.createElement("tr");
      tr.dataset.index = String(index);
      tr.tabIndex = -1;
      const number = document.createElement("th");
      number.scope = "row";
      number.className = "rownum";
      number.textContent = String(index + 1);
      tr.append(number);
      table.columns.forEach((column, c) => {
        const td = document.createElement("td");
        const value = record[c] ?? "";
        td.textContent = displayCell(value);
        if (alignOf(column.type) === "right") td.className = "num";
        if (value.length > 60 || value !== td.textContent) td.title = value;
        tr.append(td);
      });
      fragment.append(tr);
    }
    body.append(fragment);
    drawn = end;
    const left = shown.length - drawn;
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(PAGE, left).toLocaleString()} more (${left.toLocaleString()} left)`;
  }

  function refresh() {
    shown = viewRows(table, state);
    sortButtons.forEach((button, index) => {
      const column = table.columns[index]!;
      const active = state.sort?.column === index;
      button.textContent = `${column.name} `;
      const mark = document.createElement("span");
      mark.className = "column-type";
      mark.textContent = active ? (state.sort!.descending ? "▼" : "▲") : TYPE_MARK[column.type];
      button.append(mark);
      button.setAttribute("aria-sort", active ? (state.sort!.descending ? "descending" : "ascending") : "none");
      button.parentElement!.setAttribute("aria-sort", active ? (state.sort!.descending ? "descending" : "ascending") : "none");
    });
    const total = table.rows.length;
    count.textContent = `${shown.length === total ? "" : `${shown.length.toLocaleString()} of `}${total.toLocaleString()} rows · ${table.columns.length} columns`;
    body.replaceChildren();
    drawn = 0;
    drawMore();
  }

  refresh();
  return { table, shown: () => shown, text: () => toDelimited(table, shown) };
}
