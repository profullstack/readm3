/**
 * A line diff for file history: what changed between two versions, as hunks of
 * removed and added lines with their positions. Shared by the browser (change counts
 * and snippets in the history panel) and the server (the AI summary is asked about
 * the hunks, not the whole file).
 *
 * The common head and tail are trimmed first, which is most of any real edit; the
 * changed middle is aligned by longest common subsequence. A middle too large to
 * align cheaply is reported as replaced wholesale, which is still the truth.
 */
export interface Hunk {
  /** 1-based line in the old version where the hunk starts. */
  oldStart: number;
  /** 1-based line in the new version where the hunk starts. */
  newStart: number;
  removed: string[];
  added: string[];
}
export interface Diff { hunks: Hunk[]; added: number; removed: number; }

/** Cells in the alignment table; past this the middle is reported as replaced. */
const MAX_CELLS = 4_000_000;

export const lines = (text: string): string[] => text === "" ? [] : text.replace(/\r\n?/g, "\n").split("\n");

export function diffLines(before: string, after: string): Diff {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const oldMiddle = a.slice(head, a.length - tail);
  const newMiddle = b.slice(head, b.length - tail);
  const hunks: Hunk[] = [];
  if (oldMiddle.length || newMiddle.length) {
    if (!oldMiddle.length || !newMiddle.length || (oldMiddle.length + 1) * (newMiddle.length + 1) > MAX_CELLS) {
      hunks.push({ oldStart: head + 1, newStart: head + 1, removed: oldMiddle, added: newMiddle });
    } else {
      hunks.push(...align(oldMiddle, newMiddle, head));
    }
  }
  return {
    hunks,
    added: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
    removed: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0),
  };
}

/** LCS over the changed middle; lines are interned to numbers so comparisons are cheap. */
function align(a: string[], b: string[], offset: number): Hunk[] {
  const ids = new Map<string, number>();
  const intern = (line: string) => { let n = ids.get(line); if (n === undefined) ids.set(line, n = ids.size); return n; };
  const x = a.map(intern);
  const y = b.map(intern);
  const width = y.length + 1;
  // table[i][j] = LCS length of x[i..] and y[j..], filled from the end.
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  const start = () => open ??= (hunks.push({ oldStart: offset + i + 1, newStart: offset + j + 1, removed: [], added: [] }), hunks.at(-1)!);
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { open = null; i++; j++; }
    else if (j < y.length && (i === x.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) { start().added.push(b[j]!); j++; }
    else { start().removed.push(a[i]!); i++; }
  }
  return hunks;
}

/**
 * A few changed lines to show for a version, removals first in each hunk, each
 * marked + or -, trimmed to a readable width. Empty when nothing changed.
 */
export function snippet(diff: Diff, maxLines = 6, width = 120): string[] {
  const out: string[] = [];
  for (const hunk of diff.hunks) {
    for (const line of hunk.removed) out.push(`- ${line}`);
    for (const line of hunk.added) out.push(`+ ${line}`);
    if (out.length >= maxLines) break;
  }
  return out.slice(0, maxLines).map((line) => line.length > width ? `${line.slice(0, width - 1)}…` : line);
}
