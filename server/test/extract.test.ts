import { test, expect, describe } from "bun:test";
import { decodeEntities, documentText, extractable, legacyText, Zip } from "../extract.ts";
import { DOCX, zip } from "./zip.ts";

describe("office text", () => {
  test("a Word document reads paragraph by paragraph, entities decoded, indentation dropped", async () => {
    expect(await documentText("plan.docx", DOCX)).toEqual({ text: "Quarterly plan\nBudget: $4,200 & rising\tQ3", legacy: false });
  });

  test("a PowerPoint deck reads slide by slide in number order, with speaker notes", async () => {
    const deck = zip({
      "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Subtitle</a:t></a:r></a:p></p:sld>",
      "ppt/notesSlides/notesSlide1.xml": "<p:notes><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:notes>",
    });
    const { text } = await documentText("deck.pptx", deck);
    expect(text).toBe("Slide 1\nTitle\nSubtitle\nNotes: Say hello\n\nSlide 2\nSecond\n\nSlide 10\nLast");
  });

  test("an Excel workbook reads each sheet by name, row by row, with shared and inline strings", async () => {
    const book = zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Budget" sheetId="1"/><sheet name="Q&amp;A" sheetId="2"/></sheets></workbook>`,
      "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Ser</t></r><r><t>vers</t></r></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>4200</v></c><c r="C2"/></row></sheetData></worksheet>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Why?</t></is></c></row></sheetData></worksheet>`,
    });
    const { text } = await documentText("budget.xlsx", book);
    expect(text).toBe("Sheet: Budget\nItem\tCost\nServers\t4200\n\nSheet: Q&A\nWhy?");
  });

  test("OpenDocument text and an EPUB in spine order", async () => {
    const odt = zip({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": "<office:text><text:h>Plan</text:h><text:p>Ship<text:s/>it<text:tab/>Friday</text:p></office:text>" }, ["mimetype"]);
    expect((await documentText("plan.odt", odt)).text).toBe("Plan\nShip it\tFriday");
    const book = zip({
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      "OEBPS/content.opf": `<package><manifest><item id="b" href="ch%202.xhtml"/><item id="a" href="ch1.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
      "OEBPS/ch1.xhtml": "<html><head><title>x</title><style>p{}</style></head><body><h1>One</h1><p>First&#8212;chapter.</p></body></html>",
      "OEBPS/ch 2.xhtml": "<html><body><p>Second<br/>chapter.</p><script>alert(1)</script></body></html>",
    });
    expect((await documentText("book.epub", book)).text).toBe("One\nFirst—chapter.\n\nSecond\nchapter.");
  });

  test("an older Office file gives up its readable runs, UTF-16 and single-byte, without the noise", () => {
    const utf16 = new Uint8Array([...new TextEncoder().encode("Quarterly report for the board")].flatMap((b) => [b, 0]));
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, ...utf16, 0, 0, 0xff, 0xfe, ...new TextEncoder().encode("Revenue grew nine percent"), 0, 7, 0x41, 0x42]);
    expect(legacyText(bytes)).toBe("Quarterly report for the board\nRevenue grew nine percent");
  });

  test("what can be read, and what is not an archive", async () => {
    expect(["a.docx", "b.XLSX", "c.pptx", "d.odp", "e.epub", "f.doc", "g.xls", "h.ppt"].every(extractable)).toBe(true);
    expect(extractable("a.zip")).toBe(false);
    await expect(documentText("broken.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow("not a zip archive");
    expect(decodeEntities("&lt;a&gt; &#x41;&#66; &bogus;")).toBe("<a> AB &bogus;");
    expect(new Zip(DOCX).names()).toContain("word/document.xml");
  });
});
