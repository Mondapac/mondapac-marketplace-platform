import { inflateSync } from 'node:zlib';

// The intake checks of an uploaded certificate file that need no library (certification design
// 9.3, simplified for the first release by the owner's decision of the catalog photos: type by
// content only, size and count limits, no scanner, no sandbox). Pure: bytes in, a verdict out.

/** The largest file accepted, in bytes (design 5.1). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Pages a PDF may hold (design 9.3). */
export const MAX_PDF_PAGES = 50;

/** Why a file was refused: codes only, never a name or content. */
export type DocumentRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.unreadable'
  | 'file.too-many-pages'
  | 'file.encrypted'
  | 'file.active-content';

export type DocumentMediaType = 'image/jpeg' | 'image/png' | 'application/pdf';

/**
 * The type from the first bytes, never from a name or a declared type. HEIC and HEIF are not
 * accepted in this release (no decoder was chosen): they are `file.unsupported-type` with the rest.
 */
export function detectMediaType(bytes: Uint8Array): DocumentMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((byte, index) => bytes[index] === byte)) return 'image/png';
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  return null;
}

/**
 * The names that make a PDF active or hidden content (brief s5; design 9.3): scripts, launch and
 * open actions, additional actions, embedded files, rich media, forms and XFA. `/Encrypt` is the
 * encrypted file. A name ends at a delimiter or white space, so `/JSON` is not `/JS`.
 */
const ACTIVE_NAMES = [
  'JavaScript',
  'JS',
  'Launch',
  'EmbeddedFile',
  'EmbeddedFiles',
  'OpenAction',
  'AA',
  'RichMedia',
  'XFA',
  'AcroForm',
  'GoToE',
  'SubmitForm',
  'ImportData',
] as const;
const NAME_END = String.raw`(?=[\s()<>\[\]{}/%]|$)`;
const ACTIVE = new RegExp(String.raw`/(?:${ACTIVE_NAMES.join('|')})${NAME_END}`);
const ENCRYPTED = new RegExp(String.raw`/Encrypt${NAME_END}`);
const PAGE = new RegExp(String.raw`/Type\s*/Page${NAME_END}`, 'g');
const PAGES_COUNT =
  /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d{1,6})|\/Count\s+(\d{1,6})[^>]*?\/Type\s*\/Pages\b/g;
const OBJECT_STREAM = /\/Type\s*\/ObjStm\b/;

/** Streams inflated at most, each at most this many bytes (object streams only). */
const MAX_OBJECT_STREAMS = 64;
const MAX_INFLATED_BYTES = 8 * 1024 * 1024;

/** `#41` in a name is `A`: decoded first, so `/Java#53cript` cannot hide a name. */
function decodeNameEscapes(text: string): string {
  return text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** The inflated text of the compressed object streams, where objects can hide from a byte scan. */
function objectStreamTexts(raw: string, bytes: Uint8Array): string[] {
  const texts: string[] = [];
  let from = 0;
  while (texts.length < MAX_OBJECT_STREAMS) {
    const keyword = raw.indexOf('stream', from);
    if (keyword < 0) break;
    from = keyword + 6;
    if (raw.startsWith('endstream', keyword - 3)) continue;
    // The dictionary sits right before the keyword: look back a bounded distance.
    const head = raw.slice(Math.max(0, keyword - 400), keyword);
    if (!OBJECT_STREAM.test(head)) continue;
    let start = keyword + 6;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      const inflated = inflateSync(bytes.subarray(start, end), {
        maxOutputLength: MAX_INFLATED_BYTES,
      });
      texts.push(inflated.toString('latin1'));
    } catch {
      // An object stream that does not inflate cannot be read: the file is unreadable.
      texts.push('\u0000unreadable-object-stream');
    }
    from = end;
  }
  return texts;
}

export type PdfVerdict =
  | { readonly ok: true; readonly pageCount: number }
  | { readonly ok: false; readonly code: DocumentRefusalCode };

/**
 * Checks a PDF by its bytes: it starts with `%PDF-`, ends with `%%EOF` near its end, is not
 * encrypted, holds none of the active names above and has at most {@link MAX_PDF_PAGES} pages
 * (counted by `/Type /Page` objects, or the largest `/Count` of a page tree).
 *
 * The scan covers the whole file and, beyond the first release's byte scan, the object streams it
 * can inflate (cross-reference streams and objects compressed with Flate, bounded in number and
 * size). A name inside a stream that uses another filter, or an object that a viewer reconstructs
 * from a damaged file, is out of reach; the file is only ever served back as a download, never
 * rendered by this server (design 9.4). No scanner and no sandbox yet.
 */
export function inspectPdf(bytes: Uint8Array): PdfVerdict {
  if (detectMediaType(bytes) !== 'application/pdf') {
    return { ok: false, code: 'file.unsupported-type' };
  }
  const raw = Buffer.from(bytes).toString('latin1');
  if (!raw.slice(-2048).includes('%%EOF')) return { ok: false, code: 'file.unreadable' };
  const texts = [decodeNameEscapes(raw), ...objectStreamTexts(raw, bytes).map(decodeNameEscapes)];
  if (texts.some((text) => text.includes('\u0000unreadable-object-stream'))) {
    return { ok: false, code: 'file.unreadable' };
  }
  if (texts.some((text) => ENCRYPTED.test(text))) return { ok: false, code: 'file.encrypted' };
  if (texts.some((text) => ACTIVE.test(text))) return { ok: false, code: 'file.active-content' };

  let pages = 0;
  let declared = 0;
  for (const text of texts) {
    pages += [...text.matchAll(PAGE)].length;
    for (const match of text.matchAll(PAGES_COUNT)) {
      declared = Math.max(declared, Number(match[1] ?? match[2]));
    }
  }
  const pageCount = Math.max(pages, declared);
  if (pageCount < 1) return { ok: false, code: 'file.unreadable' };
  if (pageCount > MAX_PDF_PAGES) return { ok: false, code: 'file.too-many-pages' };
  return { ok: true, pageCount };
}
