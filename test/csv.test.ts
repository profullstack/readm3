import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  columnStats,
  detectHeader,
  isTableName,
  letterName,
  looksLikeTable,
  nextSort,
  parseFilter,
  parseRecords,
  parseTable,
  sniffDelimiter,
  toDelimited,
  toNumber,
  viewRows,
} from "../src/csv.ts";

const PEOPLE = `name,city,age,joined,active
Ada,London,36,2024-01-05,yes
Grace,"Arlington, VA",85,2023-11-30,no
Linus,Helsinki,54,2025-03-01,yes
Margaret,Boston,,2022-07-14,yes
`;

describe("parseRecords", () => {
  it("handles quotes, escaped quotes, embedded delimiters and line breaks", () => {
    const records = parseRecords('a,"b,c","say ""hi""","two\nlines"\r\nx,y,z,w', ",");
    assert.deepEqual(records, [["a", "b,c", 'say "hi"', "two\nlines"], ["x", "y", "z", "w"]]);
  });

  it("drops a BOM, blank lines and the trailing newline", () => {
    assert.deepEqual(parseRecords("﻿a,b\n\n1,2\n", ","), [["a", "b"], ["1", "2"]]);
  });

  it("keeps empty fields", () => {
    assert.deepEqual(parseRecords("a,,c\n,,\n", ","), [["a", "", "c"], ["", "", ""]]);
  });
});

describe("delimiters", () => {
  it("sniffs comma, tab, semicolon and pipe", () => {
    assert.equal(sniffDelimiter(PEOPLE), ",");
    assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3\n"), "\t");
    assert.equal(sniffDelimiter("a;b;c\n1,5;2;3\n4;5;6\n"), ";");
    assert.equal(sniffDelimiter("a|b\n1|2\n"), "|");
  });

  it("prefers the delimiter giving more fields when two are equally consistent", () => {
    assert.equal(sniffDelimiter("name\tnote\tn\nAda\tx, y\t1\nBob\tp, q\t2\n"), "\t");
  });

  it("trusts a .tsv or .psv name", () => {
    assert.equal(sniffDelimiter("a,b\n1,2\n", "data.tsv"), "\t");
    assert.equal(sniffDelimiter("a,b\n1,2\n", "data.psv"), "|");
  });
});

describe("looksLikeTable", () => {
  it("recognises data", () => {
    assert.equal(looksLikeTable(PEOPLE), true);
    assert.equal(looksLikeTable("id\tname\n1\ta\n2\tb\n"), true);
    assert.equal(looksLikeTable("x, y, z\n1, 2, 3\n4, 5, 6\n7, 8, 9\n"), true);
  });

  it("does not mistake prose, code or two lines for a table", () => {
    assert.equal(looksLikeTable("Hello, world.\nThis is a note, really.\nNothing more, honestly.\n"), false);
    assert.equal(looksLikeTable("foo(a, b);\nbar(c, d);\nbaz(e, f);\n"), false);
    assert.equal(looksLikeTable("a,b\n1,2\n"), false);
    assert.equal(looksLikeTable("one, two\nthree\nfour, five, six\n"), false);
  });
});

describe("parseTable", () => {
  it("names and types the columns", () => {
    const table = parseTable(PEOPLE);
    assert.equal(table.header, true);
    assert.deepEqual(table.columns.map((c) => `${c.name}:${c.type}`), ["name:text", "city:text", "age:number", "joined:date", "active:boolean"]);
    assert.equal(table.rows.length, 4);
    assert.equal(table.rows[1]![1], "Arlington, VA");
  });

  it("detects a file with no header and letters its columns", () => {
    const table = parseTable("1,2.5,x\n2,3.5,y\n3,4.5,z\n");
    assert.equal(table.header, false);
    assert.deepEqual(table.columns.map((c) => c.name), ["A", "B", "C"]);
    assert.equal(table.rows.length, 3);
    assert.equal(letterName(27), "AB");
  });

  it("pads short records, keeps extra fields under letter names, and counts both", () => {
    const table = parseTable("a,b,c\n1,2\n1,2,3,4\n1,2,3\n");
    assert.deepEqual(table.columns.map((c) => c.name), ["a", "b", "c", "D"]);
    assert.deepEqual(table.rows, [["1", "2", "", ""], ["1", "2", "3", "4"], ["1", "2", "3", ""]]);
    assert.equal(table.ragged, 2);
  });

  it("header detection rejects blanks, duplicates and numbers over numbers", () => {
    assert.equal(detectHeader([["a", ""], ["1", "2"]]), false);
    assert.equal(detectHeader([["a", "a"], ["1", "2"]]), false);
    assert.equal(detectHeader([["10", "x"], ["1", "y"]]), false);
    assert.equal(detectHeader([["n", "x"], ["1", "y"]]), true);
  });
});

describe("numbers", () => {
  it("reads grouping, currency, percent and exponents", () => {
    assert.equal(toNumber("1,234.5"), 1234.5);
    assert.equal(toNumber("$12"), 12);
    assert.equal(toNumber("-3e2"), -300);
    assert.equal(toNumber("45%"), 45);
    assert.ok(Number.isNaN(toNumber("12a")));
    assert.ok(Number.isNaN(toNumber("")));
  });
});

describe("viewRows", () => {
  const table = parseTable(PEOPLE);
  const names = (indices: number[]) => indices.map((i) => table.rows[i]![0]);

  it("sorts numbers as numbers, with empties last both ways", () => {
    assert.deepEqual(names(viewRows(table, { sort: { column: 2 } })), ["Ada", "Linus", "Grace", "Margaret"]);
    assert.deepEqual(names(viewRows(table, { sort: { column: 2, descending: true } })), ["Grace", "Linus", "Ada", "Margaret"]);
  });

  it("sorts dates as dates", () => {
    assert.deepEqual(names(viewRows(table, { sort: { column: 3 } })), ["Margaret", "Grace", "Ada", "Linus"]);
  });

  it("filters by free text, column text, comparisons and negation", () => {
    assert.deepEqual(names(viewRows(table, { filter: "lon" })), ["Ada"]);
    assert.deepEqual(names(viewRows(table, { filter: "age>40" })), ["Grace", "Linus"]);
    assert.deepEqual(names(viewRows(table, { filter: "age>=36 active=yes" })), ["Ada", "Linus"]);
    assert.deepEqual(names(viewRows(table, { filter: "!active=yes" })), ["Grace"]);
    assert.deepEqual(names(viewRows(table, { filter: 'city:"arlington, va"' })), ["Grace"]);
    assert.deepEqual(names(viewRows(table, { filter: "#1:mar" })), ["Margaret"]);
    assert.deepEqual(names(viewRows(table, { filter: "joined<2024-01-01", sort: { column: 0 } })), ["Grace", "Margaret"]);
  });

  it("treats an unknown column as free text", () => {
    assert.deepEqual(parseFilter("nope:x", table.columns), [{ column: null, op: ":", value: "nope:x", negate: false }]);
  });

  it("cycles ascending, descending, off", () => {
    assert.deepEqual(nextSort(null, 2), { column: 2 });
    assert.deepEqual(nextSort({ column: 2 }, 2), { column: 2, descending: true });
    assert.equal(nextSort({ column: 2, descending: true }, 2), null);
    assert.deepEqual(nextSort({ column: 2 }, 1), { column: 1 });
  });
});

describe("columnStats", () => {
  it("summarises a number column", () => {
    const table = parseTable(PEOPLE);
    const stats = columnStats(table, 2);
    assert.equal(stats.count, 4);
    assert.equal(stats.empty, 1);
    assert.equal(stats.min, "36");
    assert.equal(stats.max, "85");
    assert.equal(stats.sum, 175);
    assert.equal(stats.median, 54);
  });

  it("ranks the most frequent values", () => {
    const stats = columnStats(parseTable(PEOPLE), 4);
    assert.deepEqual(stats.top[0], { value: "yes", count: 3 });
  });
});

describe("toDelimited and names", () => {
  it("writes the view back, quoting only what needs it", () => {
    const table = parseTable(PEOPLE);
    const text = toDelimited(table, [1]);
    assert.equal(text, 'name,city,age,joined,active\nGrace,"Arlington, VA",85,2023-11-30,no\n');
    assert.deepEqual(parseTable(text).rows, [table.rows[1]]);
  });

  it("knows table file names", () => {
    assert.equal(isTableName("x/data.CSV"), true);
    assert.equal(isTableName("a.tsv"), true);
    assert.equal(isTableName("a.md"), false);
  });
});

describe("toMarkdownTable", () => {
  it("escapes cells so data never becomes formatting, and right-aligns numbers", async () => {
    const { toMarkdownTable } = await import("../src/csv.ts");
    const text = toMarkdownTable(parseTable("name,n\n*bold*,1\na|b,2\n"));
    assert.equal(text, "| name | n |\n| --- | ---: |\n| \\*bold\\* | 1 |\n| a\\|b | 2 |\n");
  });
});

describe("queryTable", () => {
  it("filters, sorts, pages and summarises for an agent", async () => {
    const { queryTable } = await import("../src/csv.ts");
    const result = queryTable(PEOPLE, { filter: "active=yes", sort: "age", descending: true, limit: 1, stats: "age" });
    assert.equal(result.total, 4);
    assert.equal(result.matched, 3);
    assert.deepEqual(result.rows, [{ row: 3, name: "Linus", city: "Helsinki", age: "54", joined: "2025-03-01", active: "yes" }]);
    assert.equal(result.stats?.mean, 45);
    assert.throws(() => queryTable(PEOPLE, { sort: "nope" }), /No column "nope"/);
    assert.equal(queryTable(PEOPLE, { sort: 3 }).rows[0]!.name, "Ada");
  });
});
