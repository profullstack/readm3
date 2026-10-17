/**
 * Quick open and the command palette: one dialog, a text box, and a ranked list.
 * Ranking is fuzzy in the Sublime way: the query's characters must appear in order,
 * and a match scores higher when its characters are adjacent, start a word, or fall in
 * the last path segment (so "vts" finds site/viewer.ts before a folder named "v").
 */
export interface PaletteItem { label: string; detail?: string; run(): void; }

/** A score for `label` against `query`, or -1 when the characters are not all there in order. */
export function score(query: string, label: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const text = label.toLowerCase();
  const nameStart = label.lastIndexOf("/") + 1;
  let total = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    const at = text.indexOf(char, from);
    if (at < 0) return -1;
    let points = 1;
    if (at === previous + 1) points += 5;
    if (at === 0 || /[\s/._\-]/.test(text[at - 1]!) || (label[at] !== text[at] && label[at - 1] === text[at - 1])) points += 4;
    if (at >= nameStart) points += 2;
    total += points;
    previous = at;
    from = at + 1;
  }
  return total * 100 - label.length;
}

export function rank<T extends { label: string }>(query: string, items: readonly T[], limit = 50): T[] {
  return items.map((item) => ({ item, points: score(query, item.label) }))
    .filter((entry) => entry.points >= 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((entry) => entry.item);
}

let dialog: HTMLDialogElement | undefined;

/** Opens the palette; `items` is asked again on every keystroke, so a prefix can switch lists. */
export function openPalette(options: { placeholder: string; initial?: string; items: (query: string) => PaletteItem[] }): void {
  dialog ??= build();
  const input = dialog.querySelector("input")!;
  const list = dialog.querySelector("ul")!;
  let shown: PaletteItem[] = [];
  let selected = 0;
  const paint = () => {
    list.replaceChildren(...shown.map((item, index) => {
      const row = document.createElement("li");
      row.id = `palette-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selected));
      const label = document.createElement("span");
      label.textContent = item.label;
      row.append(label);
      if (item.detail) {
        const detail = document.createElement("small");
        detail.textContent = item.detail;
        row.append(detail);
      }
      row.onmousedown = (event) => { event.preventDefault(); choose(index); };
      return row;
    }));
    if (!shown.length) {
      const empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = "No matches";
      list.append(empty);
    }
    input.setAttribute("aria-activedescendant", shown.length ? `palette-${selected}` : "");
    list.querySelector(`[aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
  };
  const refresh = () => { shown = options.items(input.value); selected = 0; paint(); };
  const choose = (index: number) => { const item = shown[index]; dialog!.close(); item?.run(); };
  input.placeholder = options.placeholder;
  input.value = options.initial ?? "";
  input.oninput = refresh;
  input.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length) selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      paint();
    } else if (event.key === "Enter") { event.preventDefault(); choose(selected); }
  };
  refresh();
  dialog.showModal();
  input.focus();
}

function build(): HTMLDialogElement {
  const element = document.createElement("dialog");
  element.id = "palette";
  element.className = "palette";
  element.setAttribute("aria-label", "Go to file or run a command");
  element.innerHTML = `<input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" autocomplete="off" spellcheck="false"><ul id="palette-list" role="listbox"></ul>`;
  // A click on the backdrop (the dialog itself, outside its box) closes it.
  element.addEventListener("click", (event) => { if (event.target === element) element.close(); });
  document.body.append(element);
  return element;
}
