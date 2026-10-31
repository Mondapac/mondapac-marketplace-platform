import { crc32, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { FileRefusal } from '../../domain/platform-import/import-file';
import type { ImportLimits } from '../../domain/platform-import/limits';

const inflate = promisify(inflateRaw);

/** The content type of the main part of a plain workbook (no macros, not a template). */
export const WORKBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_16 = 0xffff;
const ZIP64_32 = 0xffffffff;
/** The longest comment a ZIP end record may carry. */
const MAX_COMMENT = 0xffff;
/** The content-types part is read in full; it is a small list, never more than this. */
const MAX_CONTENT_TYPES_BYTES = 256 * 1024;

const OTHER: FileRefusal = { code: 'file.unsupported-type', detected: 'other' };
const UNREADABLE: FileRefusal = { code: 'file.unreadable' };

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressed: number;
  readonly uncompressed: number;
  readonly localOffset: number;
}

/** Parts a plain workbook never needs and that carry code, other files or links to other places. */
const FORBIDDEN_PARTS: readonly RegExp[] = [
  /(^|\/)vbaProject/i, // macros
  /(^|\/)vbaData\.xml$/i,
  /^xl\/externalLinks\//i, // links to other workbooks
  /^xl\/embeddings\//i, // embedded files and OLE objects
  /^xl\/activeX\//i,
  /^xl\/macrosheets\//i,
  /^xl\/dialogsheets\//i,
  /^xl\/ctrlProps\//i,
  /^customUI\//i,
];

/**
 * The checks of an uploaded XLSX **before any library reads it** (Hassan's limits, catalog 14a):
 * the ZIP structure is read from its central directory with plain arithmetic, nothing is unpacked
 * on trust. Each step refuses with a code and numbers, never a value from the file.
 *
 * 1. the end record must be the last thing in the file (no trailing bytes, no ZIP64, one disk);
 * 2. at most `containerEntries` entries; no encryption, only the methods stored (0) and deflate
 *    (8); clean unique names (no `..`, no leading slash, no backslash, no NUL);
 * 3. the declared sizes: their sum must stay within `decompressedBytes`, and no entry (nor the
 *    whole container) may unpack by more than `compressionRatio` once it is over `ratioFloorBytes`;
 * 4. the entries must not overlap and each must lie before the central directory, and its local
 *    header must agree with the central one (name, method), so no other reader sees a different file;
 * 5. a **real** inflate of every entry bounded by its declared size (`maxOutputLength`) and a CRC-32
 *    check, so a header that lies about its size cannot get past step 3;
 * 6. the structure: `[Content_Types].xml` and `xl/workbook.xml` exist, the workbook part is the
 *    plain spreadsheet type (a macro-enabled, template or binary workbook is refused), and no part is
 *    a macro project, an external link, an embedded object or ActiveX control; no XML part opens a DTD.
 */
export async function inspectXlsxContainer(
  bytes: Uint8Array,
  limits: ImportLimits,
): Promise<Result<readonly string[], FileRefusal>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.byteLength;

  // 1. The end record, found from the back and required to end the file exactly.
  if (size < 22) return err(OTHER);
  let eocd = -1;
  for (let at = size - 22; at >= Math.max(0, size - 22 - MAX_COMMENT); at -= 1) {
    if (view.getUint32(at, true) === EOCD && at + 22 + view.getUint16(at + 20, true) === size) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return err(OTHER);
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const onDisk = view.getUint16(eocd + 8, true);
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === ZIP64_16 || cdSize === ZIP64_32 || cdOffset === ZIP64_32) return err(UNREADABLE);
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return err(UNREADABLE);
  if (total === 0 || cdOffset + cdSize !== eocd) return err(OTHER);
  // 2. Entries.
  if (total > limits.containerEntries) {
    return err({ code: 'file.unpacked-too-large', maxBytes: limits.decompressedBytes });
  }

  const entries: Entry[] = [];
  const seen = new Set<string>();
  let at = cdOffset;
  let declaredTotal = 0;
  let packedTotal = 0;
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL) return err(UNREADABLE);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) return err(UNREADABLE);
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) return err(OTHER); // encrypted
    if (method !== 0 && method !== 8) return err(UNREADABLE);
    if (compressed === ZIP64_32 || uncompressed === ZIP64_32 || localOffset === ZIP64_32) {
      return err(UNREADABLE);
    }
    if (method === 0 && compressed !== uncompressed) return err(UNREADABLE);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(at + 46, at + 46 + nameLength),
      );
    } catch {
      return err(UNREADABLE);
    }
    if (!cleanName(name) || seen.has(name.toLowerCase())) return err(UNREADABLE);
    seen.add(name.toLowerCase());
    // 3. The declared sizes, summed and ratioed before anything is unpacked.
    declaredTotal += uncompressed;
    packedTotal += compressed;
    if (declaredTotal > limits.decompressedBytes) {
      return err({ code: 'file.unpacked-too-large', maxBytes: limits.decompressedBytes });
    }
    if (
      uncompressed >= limits.ratioFloorBytes &&
      uncompressed > compressed * limits.compressionRatio
    ) {
      return err({ code: 'file.unpacked-too-large', maxBytes: limits.decompressedBytes });
    }
    entries.push({ name, method, crc, compressed, uncompressed, localOffset });
    at = next;
  }
  if (at !== eocd) return err(UNREADABLE);
  if (
    declaredTotal >= limits.ratioFloorBytes &&
    declaredTotal > Math.max(packedTotal, 1) * limits.compressionRatio
  ) {
    return err({ code: 'file.unpacked-too-large', maxBytes: limits.decompressedBytes });
  }

  // 6a. The structure by name, before any entry is unpacked.
  const names = entries.map((entry) => entry.name);
  if (!seen.has('[content_types].xml') || !seen.has('xl/workbook.xml')) return err(OTHER);
  if (names.some((name) => FORBIDDEN_PARTS.some((pattern) => pattern.test(name)))) {
    return err(OTHER);
  }

  // 4. Local headers: agreement with the central directory, no overlap, all before the directory.
  const ranges: { start: number; end: number }[] = [];
  const dataStart = new Map<Entry, number>();
  for (const entry of entries) {
    const off = entry.localOffset;
    if (off + 30 > cdOffset || view.getUint32(off, true) !== LOCAL) return err(UNREADABLE);
    const localMethod = view.getUint16(off + 8, true);
    const localName = view.getUint16(off + 26, true);
    const localExtra = view.getUint16(off + 28, true);
    const start = off + 30 + localName + localExtra;
    const end = start + entry.compressed;
    if (localMethod !== entry.method || end > cdOffset) return err(UNREADABLE);
    let nameInHeader: string;
    try {
      nameInHeader = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(off + 30, off + 30 + localName),
      );
    } catch {
      return err(UNREADABLE);
    }
    if (nameInHeader !== entry.name) return err(UNREADABLE);
    ranges.push({ start: off, end });
    dataStart.set(entry, start);
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start < ranges[index - 1]!.end) return err(UNREADABLE);
  }

  // 5 and 6b. A real, bounded inflate of every entry; the content types and the workbook are read.
  let contentTypes = '';
  for (const entry of entries) {
    const start = dataStart.get(entry)!;
    const packed = bytes.subarray(start, start + entry.compressed);
    let content: Uint8Array;
    if (entry.method === 0) {
      content = packed;
    } else {
      try {
        // `maxOutputLength` stops the inflate the moment it passes the declared size plus one.
        content = await inflate(packed, { maxOutputLength: entry.uncompressed + 1 });
      } catch {
        return err({ code: 'file.unpacked-too-large', maxBytes: limits.decompressedBytes });
      }
    }
    if (content.byteLength !== entry.uncompressed || crc32(content) !== entry.crc) {
      return err(UNREADABLE);
    }
    if (/\.(xml|rels)$/i.test(entry.name)) {
      const head = Buffer.from(content.subarray(0, 4096)).toString('latin1');
      if (/<!(DOCTYPE|ENTITY)/i.test(head)) return err(OTHER);
    }
    if (entry.name.toLowerCase() === '[content_types].xml') {
      if (entry.uncompressed > MAX_CONTENT_TYPES_BYTES) return err(UNREADABLE);
      contentTypes = Buffer.from(content).toString('utf8');
    }
  }
  if (!workbookIsPlain(contentTypes)) return err(OTHER);
  return ok(names);
}

/** True when the content types name `/xl/workbook.xml` as the plain workbook and nothing macro-enabled. */
export function workbookIsPlain(contentTypes: string): boolean {
  if (/macroEnabled|vbaProject|ms-office\.vbaProject/i.test(contentTypes)) return false;
  const override = /<Override\b[^>]*>/gi;
  for (const tag of contentTypes.match(override) ?? []) {
    const part = /\bPartName\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (part?.toLowerCase() !== '/xl/workbook.xml') continue;
    const type = /\bContentType\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    return type === WORKBOOK_CONTENT_TYPE;
  }
  return false;
}

function cleanName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
  return !name.split('/').some((part) => part === '..' || part === '.');
}
