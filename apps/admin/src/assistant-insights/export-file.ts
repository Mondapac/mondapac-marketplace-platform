// The export of the unanswered-questions list, built in the browser from the rows on show (the
// route has no export: it already keeps at most 200 masked groups). CSV and XLSX, no dependency.

export type Cell = string | number;

const TAB = 9;
const CARRIAGE_RETURN = 13;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A spreadsheet runs a cell that starts with one of these as a formula: buyer text must not. */
const FORMULA_START = new Set([
  '=',
  '+',
  '-',
  '@',
  String.fromCharCode(TAB),
  String.fromCharCode(CARRIAGE_RETURN),
]);

/** Whether XML 1.0 (and so XLSX) can hold the character: no control characters but tab, LF, CR. */
function xmlValid(code: number): boolean {
  return code >= 0x20
    ? code !== 0xfffe && code !== 0xffff
    : code === 9 || code === 10 || code === 13;
}

/** The text without the characters a workbook cannot hold. */
export function xmlSafe(value: string): string {
  return Array.from(value)
    .filter((char) => xmlValid(char.codePointAt(0) ?? 0))
    .join('');
}

export function safeText(value: string): string {
  const clean = xmlSafe(value);
  return FORMULA_START.has(clean.charAt(0)) ? `'${clean}` : clean;
}

function csvCell(cell: Cell): string {
  const text = typeof cell === 'number' ? String(cell) : safeText(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 with a byte order mark (Excel needs it) and CRLF line ends. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): Uint8Array {
  const lines = [header, ...rows].map((line) => line.map(csvCell).join(','));
  return new TextEncoder().encode(`${BYTE_ORDER_MARK}${lines.join('\r\n')}\r\n`);
}

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of stored (uncompressed) entries: enough for a small workbook. */
export function zipStore(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50);
    u16(lv, 4, 20);
    u16(lv, 6, 0x0800); // UTF-8 names
    u32(lv, 14, crc);
    u32(lv, 18, entry.data.length);
    u32(lv, 22, entry.data.length);
    u16(lv, 26, name.length);
    local.set(name, 30);
    parts.push(local, entry.data);
    const head = new Uint8Array(46 + name.length);
    const hv = new DataView(head.buffer);
    u32(hv, 0, 0x02014b50);
    u16(hv, 4, 20);
    u16(hv, 6, 20);
    u16(hv, 8, 0x0800);
    u32(hv, 16, crc);
    u32(hv, 20, entry.data.length);
    u32(hv, 24, entry.data.length);
    u16(hv, 28, name.length);
    u32(hv, 42, offset);
    head.set(name, 46);
    central.push(head);
    offset += local.length + entry.data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, size);
  u32(ev, 16, offset);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** One sheet; text is stored as text (an inline string), never as a formula. */
export function toXlsx(
  sheetName: string,
  header: readonly string[],
  rows: readonly (readonly Cell[])[],
): Uint8Array {
  const cell = (value: Cell, column: number, row: number) => {
    const ref = `${columnName(column)}${row}`;
    return typeof value === 'number'
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(xmlSafe(value))}</t></is></c>`;
  };
  const sheetRows = [header, ...rows]
    .map(
      (line, index) =>
        `<row r="${index + 1}">${line.map((value, column) => cell(value, column, index + 1)).join('')}</row>`,
    )
    .join('');
  const xml = (body: string) =>
    encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`);
  const name = escapeXml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  return zipStore([
    {
      name: '[Content_Types].xml',
      data: xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: xml(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
      ),
    },
  ]);
}
