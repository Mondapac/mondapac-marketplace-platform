import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';

/** One entry of a hand-made ZIP file. The `declared*` fields let a test make a header lie. */
export interface ZipEntrySpec {
  readonly name: string;
  readonly data: Buffer;
  /** 0 stored, 8 deflate (default). */
  readonly method?: 0 | 8;
  readonly declaredUncompressed?: number;
  readonly flags?: number;
}

/** A minimal ZIP writer for tests: local headers, data, central directory, end record. */
export function zipOf(entries: readonly ZipEntrySpec[], trailing = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const packed = method === 8 ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const uncompressed = entry.declaredUncompressed ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end, trailing]);
}

export const MAIN_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

export function contentTypesXml(workbookType: string): Buffer {
  return Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${workbookType}"/></Types>`,
  );
}

/** The two parts that make a ZIP look like a workbook to the container checks. */
export function workbookSkeleton(workbookType = MAIN_TYPE): ZipEntrySpec[] {
  return [
    { name: '[Content_Types].xml', data: contentTypesXml(workbookType) },
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') },
  ];
}

export type Cells = readonly (readonly ExcelJS.CellValue[])[];

/** A real workbook written by exceljs: one sheet of the given rows (the first row is the header). */
export async function workbookBytes(
  rows: Cells,
  extraSheets: Readonly<Record<string, Cells>> = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  for (const row of rows) sheet.addRow([...row]);
  for (const [name, more] of Object.entries(extraSheets)) {
    const other = workbook.addWorksheet(name);
    for (const row of more) other.addRow([...row]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
