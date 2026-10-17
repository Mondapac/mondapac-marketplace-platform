import { inflateSync } from 'node:zlib';

// The intake checks of an uploaded certificate file that need no library (certification design
// 9.3, simplified for the first release by the owner's decision of the catalog photos: type by
// content only, size and count limits, no scanner, no sandbox). Pure: bytes in, a verdict out.

/** The largest file accepted, in bytes (design 5.1). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Pages a PDF may hold (design 9.3). */
export const MAX_PDF_PAGES = 20;

/** Why a file was refused: codes only, never a name or content. */
export type DocumentRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.unreadable'
  | 'file.too-many-pages'
  | 'file.encrypted'
  | 'file.active-content'
  | 'file.too-complex'
  | 'file.inspection-timeout';

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

/** Compressed object streams inflated at most; more than this is refused, never skipped. */
export const MAX_OBJECT_STREAMS = 64;
/** One object stream inflates to at most this many bytes. */
const MAX_STREAM_INFLATED_BYTES = 8 * 1024 * 1024;
/** All object streams of one file inflate to at most this many bytes together (decompression bomb). */
export const MAX_TOTAL_INFLATED_BYTES = 32 * 1024 * 1024;
/** One dictionary is read at most this far, and nested at most this deep; beyond it, refused. */
const MAX_DICTIONARY_CHARS = 256 * 1024;
const MAX_DICTIONARY_DEPTH = 32;

/** An internal stop with the refusal to answer; the scan never accepts what it could not read. */
class Refusal extends Error {
  readonly code: DocumentRefusalCode;
  constructor(code: DocumentRefusalCode) {
    super(code);
    this.code = code;
  }
}

/** `#41` in a name is `A`: decoded first, so `/Java#53cript` cannot hide a name. */
function decodeNameEscapes(text: string): string {
  return text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const isWhite = (code: number): boolean =>
  code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0;
const isDelimiter = (code: number): boolean =>
  code === 0x28 ||
  code === 0x29 ||
  code === 0x3c ||
  code === 0x3e ||
  code === 0x5b ||
  code === 0x5d ||
  code === 0x7b ||
  code === 0x7d ||
  code === 0x2f ||
  code === 0x25;

interface ScanResult {
  /** `/Type /Page` objects seen. */
  pages: number;
  /** The largest `/Count` of a `/Type /Pages` dictionary. */
  declared: number;
  /** Data ranges of the streams whose dictionary names `/ObjStm`. */
  objectStreams: { start: number; end: number }[];
}

/**
 * One pass, forward only (linear), over the dictionaries of a text: every `<< ... >>` is read
 * token by token (names with their escapes decoded, strings, nesting) within fixed bounds. A
 * dictionary that does not close within the bounds, or a stray byte inside it, is refused
 * (`file.too-complex` or `file.unreadable`): nothing is skipped on a guess. The data of a stream
 * is jumped over to its `endstream`; the ranges of object streams are returned for inflating.
 */
function scanDictionaries(text: string, withStreams: boolean): ScanResult {
  const result: ScanResult = { pages: 0, declared: 0, objectStreams: [] };
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('<<', cursor);
    if (open < 0) return result;
    const { end, objectStream } = readDictionary(text, open, result);
    cursor = end;
    if (!withStreams) continue;
    let after = end;
    while (after < text.length && isWhite(text.charCodeAt(after))) after += 1;
    if (!text.startsWith('stream', after)) continue;
    let start = after + 6;
    if (text[start] === '\r') start += 1;
    if (text[start] === '\n') start += 1;
    const dataEnd = text.indexOf('endstream', start);
    if (dataEnd < 0) throw new Refusal('file.unreadable');
    if (objectStream) {
      if (result.objectStreams.length >= MAX_OBJECT_STREAMS) throw new Refusal('file.too-complex');
      result.objectStreams.push({ start, end: dataEnd });
    }
    cursor = dataEnd + 9;
  }
}

interface Frame {
  typePages: boolean;
  count: number | null;
}

/** Reads the dictionary that opens at `open`; returns where it ends. */
function readDictionary(
  text: string,
  open: number,
  result: ScanResult,
): { end: number; objectStream: boolean } {
  const frames: Frame[] = [];
  let objectStream = false;
  let previousName: string | null = null;
  let i = open;
  for (;;) {
    if (i - open > MAX_DICTIONARY_CHARS) throw new Refusal('file.too-complex');
    if (i >= text.length) throw new Refusal('file.unreadable');
    const code = text.charCodeAt(i);
    if (code === 0x3c) {
      if (text.charCodeAt(i + 1) === 0x3c) {
        if (frames.length >= MAX_DICTIONARY_DEPTH) throw new Refusal('file.too-complex');
        frames.push({ typePages: false, count: null });
        i += 2;
      } else {
        const close = text.indexOf('>', i + 1);
        if (close < 0 || close - open > MAX_DICTIONARY_CHARS) throw new Refusal('file.too-complex');
        i = close + 1;
      }
      previousName = null;
    } else if (code === 0x3e) {
      if (text.charCodeAt(i + 1) !== 0x3e) throw new Refusal('file.unreadable');
      const frame = frames.pop();
      if (frame?.typePages && frame.count !== null) {
        result.declared = Math.max(result.declared, frame.count);
      }
      i += 2;
      previousName = null;
      if (frames.length === 0) return { end: i, objectStream };
    } else if (code === 0x2f) {
      let j = i + 1;
      while (j < text.length && !isWhite(text.charCodeAt(j)) && !isDelimiter(text.charCodeAt(j))) {
        j += 1;
      }
      const name = decodeNameEscapes(text.slice(i + 1, j));
      const frame = frames[frames.length - 1];
      if (previousName === 'Type') {
        if (name === 'ObjStm') objectStream = true;
        else if (name === 'Page') result.pages += 1;
        else if (name === 'Pages' && frame) frame.typePages = true;
      }
      previousName = name;
      i = j;
    } else if (code === 0x28) {
      let depth = 0;
      let j = i;
      do {
        const c = text.charCodeAt(j);
        if (c === 0x5c) j += 1;
        else if (c === 0x28) depth += 1;
        else if (c === 0x29) depth -= 1;
        j += 1;
        if (j - open > MAX_DICTIONARY_CHARS || j > text.length) {
          throw new Refusal('file.too-complex');
        }
      } while (depth > 0);
      i = j;
      previousName = null;
    } else if (code === 0x25) {
      while (i < text.length && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d) {
        i += 1;
        if (i - open > MAX_DICTIONARY_CHARS) throw new Refusal('file.too-complex');
      }
    } else if (code >= 0x30 && code <= 0x39) {
      let j = i;
      while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x39) j += 1;
      const frame = frames[frames.length - 1];
      if (previousName === 'Count' && frame) {
        frame.count = j - i > 9 ? 999_999_999 : Number(text.slice(i, j));
      }
      previousName = null;
      i = j;
    } else {
      if (code === 0x5b || code === 0x5d) previousName = null;
      i += 1;
    }
  }
}

export type PdfVerdict =
  | { readonly ok: true; readonly pageCount: number }
  | { readonly ok: false; readonly code: DocumentRefusalCode };

/**
 * Checks a PDF by its bytes: it starts with `%PDF-`, ends with `%%EOF` near its end, is not
 * encrypted, holds none of the active names above and has at most {@link MAX_PDF_PAGES} pages
 * (counted by `/Type /Page` objects, or the largest `/Count` of a page tree).
 *
 * The scan covers the whole file and the compressed object streams, where objects can hide. It
 * fails closed: more object streams than {@link MAX_OBJECT_STREAMS}, more inflated bytes than
 * {@link MAX_TOTAL_INFLATED_BYTES}, a dictionary that is not read within bounds, or a stream that
 * does not inflate are refused, never accepted unscanned. A name inside a stream that uses another
 * filter, or an object that a viewer reconstructs from a damaged file, is out of reach; the file
 * is only ever served back as a download, never rendered by this server (design 9.4).
 *
 * Synchronous and CPU-bound: the API runs it in a worker thread (`inspectPdfIsolated`).
 */
export function inspectPdf(bytes: Uint8Array): PdfVerdict {
  if (detectMediaType(bytes) !== 'application/pdf') {
    return { ok: false, code: 'file.unsupported-type' };
  }
  try {
    return inspectPdfOrRefuse(bytes);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code };
    throw error;
  }
}

function inspectPdfOrRefuse(bytes: Uint8Array): PdfVerdict {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  if (!raw.slice(-2048).includes('%%EOF')) throw new Refusal('file.unreadable');

  let pages = 0;
  let declared = 0;
  let budget = MAX_TOTAL_INFLATED_BYTES;
  const examine = (text: string, withStreams: boolean): ScanResult => {
    const decoded = decodeNameEscapes(text);
    if (ENCRYPTED.test(decoded)) throw new Refusal('file.encrypted');
    if (ACTIVE.test(decoded)) throw new Refusal('file.active-content');
    const found = scanDictionaries(text, withStreams);
    pages += found.pages;
    declared = Math.max(declared, found.declared);
    return found;
  };

  const top = examine(raw, true);
  for (const range of top.objectStreams) {
    if (budget <= 0) throw new Refusal('file.too-complex');
    let inflated: Buffer;
    try {
      inflated = inflateSync(bytes.subarray(range.start, range.end), {
        maxOutputLength: Math.min(MAX_STREAM_INFLATED_BYTES, budget),
      });
    } catch (error) {
      const tooBig = (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
      throw new Refusal(tooBig ? 'file.too-complex' : 'file.unreadable');
    }
    budget -= inflated.length;
    examine(inflated.toString('latin1'), false);
  }

  const pageCount = Math.max(pages, declared);
  if (pageCount < 1) return { ok: false, code: 'file.unreadable' };
  if (pageCount > MAX_PDF_PAGES) return { ok: false, code: 'file.too-many-pages' };
  return { ok: true, pageCount };
}
