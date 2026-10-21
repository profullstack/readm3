import { deflateRawSync } from "node:zlib";

/** A zip archive of the given files, each deflated (or stored, for `stored` names), as Office writes them. */
export function zip(files: Record<string, string>, stored: string[] = []): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const method = stored.includes(name) ? 0 : 8;
    const data = method ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const entry = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    locals.push(local);
    central.push(entry);
    offset += local.length;
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}

export const DOCX = zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<w:document><w:body>
    <w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Budget: </w:t></w:r><w:r><w:t>$4,200 &amp; rising</w:t></w:r><w:r><w:tab/><w:t>Q3</w:t></w:r></w:p>
  </w:body></w:document>`,
});
