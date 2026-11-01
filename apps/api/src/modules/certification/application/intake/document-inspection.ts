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
  | 'file.inspection-timeout'
  /** The malware scanner found a signature in the file. */
  | 'file.infected'
  /** The scanner gave no clean verdict (down, timed out, refused): the file is not stored. */
  | 'file.scan-unavailable'
  /** The intake is busy: try again later (maps to 429). */
  | 'request.throttled';

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
 * encrypted file. A name ends at white space or a delimiter (ISO 32000 7.2.3, NUL included), so
 * `/JSON` is not `/JS`.
 */
const ACTIVE_NAMES: ReadonlySet<string> = new Set([
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
]);

/** Object streams (and other streams that could be one) scanned at most; more is refused. */
export const MAX_OBJECT_STREAMS = 64;
/** One stream inflates to at most this many bytes. */
const MAX_STREAM_INFLATED_BYTES = 8 * 1024 * 1024;
/** All streams of one file inflate to at most this many bytes together (decompression bomb). */
export const MAX_TOTAL_INFLATED_BYTES = 16 * 1024 * 1024;
/** One dictionary is read at most this far, and nested at most this deep; beyond it, refused. */
const MAX_DICTIONARY_CHARS = 256 * 1024;
const MAX_DICTIONARY_DEPTH = 32;
/** A comment between `>>` and `stream` is at most this long; a longer one is refused. */
const MAX_GAP_CHARS = 256;
/**
 * A name longer than this cannot be an active name once its `#xx` escapes are decoded (the longest
 * is 13 characters, each written in at most 3), so it is not decoded: no allocation per name.
 */
const MAX_DECODED_NAME_RAW = 64;
const LONG_NAME = '\u0001';

/** An internal stop with the refusal to answer; the scan never accepts what it could not read. */
class Refusal extends Error {
  readonly code: DocumentRefusalCode;
  constructor(code: DocumentRefusalCode) {
    super(code);
    this.code = code;
  }
}

/** White space (NUL included) and delimiters of ISO 32000 7.2.2-7.2.3: the bytes that end a name. */
const ENDS_NAME = new Uint8Array(256);
for (const code of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) ENDS_NAME[code] = 1;
for (const char of '()<>[]{}/%') ENDS_NAME[char.charCodeAt(0)] = 1;
const isWhite = (code: number): boolean =>
  code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0;

const hexValue = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
};

/** The name in `bytes[from, to)` with its `#xx` escapes decoded (`#41` is `A`); short names only. */
function nameOf(bytes: Buffer, from: number, to: number): string {
  if (to - from > MAX_DECODED_NAME_RAW) return LONG_NAME;
  let escaped = false;
  for (let at = from; at < to; at += 1) {
    if (bytes[at] === 0x23) {
      escaped = true;
      break;
    }
  }
  if (!escaped) return bytes.toString('latin1', from, to);
  let decoded = '';
  for (let at = from; at < to; at += 1) {
    const code = bytes[at] as number;
    const high = code === 0x23 && at + 2 < to ? hexValue(bytes[at + 1] as number) : -1;
    const low = high >= 0 ? hexValue(bytes[at + 2] as number) : -1;
    if (low >= 0) {
      decoded += String.fromCharCode(high * 16 + low);
      at += 2;
    } else decoded += String.fromCharCode(code);
  }
  return decoded;
}

/**
 * Every name of the bytes, wherever it stands (in a dictionary, a trailer, plain text or a stream
 * body): `/Encrypt` is the encrypted file, an active name is active content. One forward pass; a
 * name is read by the same rule as the dictionary reader, with its escapes decoded name by name.
 */
function scanNames(bytes: Buffer): void {
  const length = bytes.length;
  let at = bytes.indexOf(0x2f);
  while (at >= 0) {
    let end = at + 1;
    while (end < length && ENDS_NAME[bytes[end] as number] === 0) end += 1;
    const name = nameOf(bytes, at + 1, end);
    if (name === 'Encrypt') throw new Refusal('file.encrypted');
    if (ACTIVE_NAMES.has(name)) throw new Refusal('file.active-content');
    at = bytes.indexOf(0x2f, end);
  }
}

/** A stream the scan must read: it could be an object stream, whatever its `/Type` says. */
interface StreamRange {
  start: number;
  end: number;
  /** `true`: one `/FlateDecode`, to inflate; `false`: no filter, the bytes are the content. */
  flate: boolean;
}

interface ScanResult {
  /** `/Type /Page` objects seen. */
  pages: number;
  /** The largest `/Count` of a `/Type /Pages` dictionary. */
  declared: number;
  streams: StreamRange[];
}

/** What the first (outer) dictionary of an object says about the stream behind it. */
interface DictionaryFacts {
  objStm: boolean;
  hasN: boolean;
  hasFirst: boolean;
  /** `/DecodeParms`, `/DP` or `/Predictor` anywhere in the dictionary. */
  hasParms: boolean;
  filters: string[];
  filterUnclear: boolean;
}

/** Skips the white space and comments that a reader skips between `>>` and `stream`. */
const gapEnd = (bytes: Buffer, from: number): number => {
  let at = from;
  while (at < bytes.length) {
    const code = bytes[at] as number;
    if (isWhite(code)) at += 1;
    else if (code === 0x25) {
      // A comment is rescanned if it holds a dictionary, so its length is bounded.
      const started = at;
      while (at < bytes.length && bytes[at] !== 0x0a && bytes[at] !== 0x0d) {
        at += 1;
        if (at - started > MAX_GAP_CHARS) throw new Refusal('file.too-complex');
      }
    } else return at;
  }
  return at;
};

/**
 * One pass, forward only (linear), over the dictionaries of the bytes: every `<< ... >>` is read
 * token by token (names with their escapes decoded, strings, nesting) within fixed bounds. A
 * dictionary that does not close within the bounds, or a stray byte inside it, is refused
 * (`file.too-complex` or `file.unreadable`): nothing is skipped on a guess. The stream behind a
 * dictionary is found after white space and comments, as a reader does, and is jumped over to its
 * `endstream`; a stream that could be an object stream is returned for reading.
 */
function scanDictionaries(bytes: Buffer, withStreams: boolean): ScanResult {
  const result: ScanResult = { pages: 0, declared: 0, streams: [] };
  let cursor = 0;
  for (;;) {
    const open = bytes.indexOf('<<', cursor, 'latin1');
    if (open < 0) return result;
    const { end, facts } = readDictionary(bytes, open, result);
    cursor = end;
    if (!withStreams) continue;
    const after = gapEnd(bytes, end);
    if (!bytes.toString('latin1', after, after + 6).startsWith('stream')) continue;
    let start = after + 6;
    if (bytes[start] === 0x0d) start += 1;
    if (bytes[start] === 0x0a) start += 1;
    const dataEnd = bytes.indexOf('endstream', start, 'latin1');
    if (dataEnd < 0) throw new Refusal('file.unreadable');
    // N and First are what a reader needs of an object stream; /Type is not checked by readers.
    if (facts.objStm || facts.hasN || facts.hasFirst) {
      if (result.streams.length >= MAX_OBJECT_STREAMS) throw new Refusal('file.too-complex');
      const unfiltered = facts.filters.length === 0;
      const plainFlate = facts.filters.length === 1 && facts.filters[0] === 'FlateDecode';
      if (facts.filterUnclear || facts.hasParms || !(unfiltered || plainFlate)) {
        throw new Refusal('file.too-complex');
      }
      result.streams.push({ start, end: dataEnd, flate: plainFlate });
    }
    cursor = dataEnd + 9;
  }
}

interface Frame {
  /** Next token is a key (`false`: its value). */
  expectValue: boolean;
  key: string;
  arrayDepth: number;
  typePages: boolean;
  count: number | null;
  countUnclear: boolean;
  filters: string[];
  filterUnclear: boolean;
  objStm: boolean;
}

const newFrame = (): Frame => ({
  expectValue: false,
  key: '',
  arrayDepth: 0,
  typePages: false,
  count: null,
  countUnclear: false,
  filters: [],
  filterUnclear: false,
  objStm: false,
});

type Value = { kind: 'name'; name: string } | { kind: 'int'; value: number } | { kind: 'other' };

const OTHER: Value = { kind: 'other' };

function onValue(result: ScanResult, frame: Frame, value: Value): void {
  if (frame.arrayDepth > 0) {
    // An element of an array value: only a filter array is read; a Count array is unclear.
    if (frame.key === 'Filter') {
      if (frame.arrayDepth === 1 && value.kind === 'name') frame.filters.push(value.name);
      else frame.filterUnclear = true;
    } else if (frame.key === 'Count') frame.countUnclear = true;
    return;
  }
  if (!frame.expectValue) return;
  frame.expectValue = false;
  switch (frame.key) {
    case 'Type':
      // A type that is not a name written here (a reference, say) leaves the structure unknown.
      if (value.kind !== 'name') throw new Refusal('file.too-complex');
      if (value.name === 'Page') result.pages += 1;
      else if (value.name === 'Pages') frame.typePages = true;
      else if (value.name === 'ObjStm') frame.objStm = true;
      break;
    case 'Count':
      if (value.kind === 'int') frame.count = value.value;
      else frame.countUnclear = true;
      break;
    case 'Filter':
      if (value.kind === 'name') frame.filters.push(value.name);
      else frame.filterUnclear = true;
      break;
    default:
  }
}

function closeFrame(result: ScanResult, frame: Frame): void {
  if (!frame.typePages) return;
  if (frame.countUnclear) throw new Refusal('file.too-complex');
  if (frame.count !== null) result.declared = Math.max(result.declared, frame.count);
}

/** Reads the dictionary that opens at `open`; returns where it ends and what it says. */
function readDictionary(
  bytes: Buffer,
  open: number,
  result: ScanResult,
): { end: number; facts: DictionaryFacts } {
  const length = bytes.length;
  const frames: Frame[] = [];
  const facts: DictionaryFacts = {
    objStm: false,
    hasN: false,
    hasFirst: false,
    hasParms: false,
    filters: [],
    filterUnclear: false,
  };

  let i = open;
  for (;;) {
    if (i - open > MAX_DICTIONARY_CHARS) throw new Refusal('file.too-complex');
    if (i >= length) throw new Refusal('file.unreadable');
    const code = bytes[i] as number;
    const frame = frames[frames.length - 1];
    if (code === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        if (frames.length >= MAX_DICTIONARY_DEPTH) throw new Refusal('file.too-complex');
        frames.push(newFrame());
        i += 2;
      } else {
        const close = bytes.indexOf(0x3e, i + 1);
        if (close < 0 || close - open > MAX_DICTIONARY_CHARS) throw new Refusal('file.too-complex');
        i = close + 1;
        if (frame) onValue(result, frame, OTHER);
      }
    } else if (code === 0x3e) {
      if (bytes[i + 1] !== 0x3e || !frame) throw new Refusal('file.unreadable');
      frames.pop();
      closeFrame(result, frame);
      i += 2;
      if (frames.length === 0) {
        facts.objStm = frame.objStm;
        facts.filters = frame.filters;
        facts.filterUnclear = frame.filterUnclear;
        return { end: i, facts };
      }
      const parent = frames[frames.length - 1] as Frame;
      onValue(result, parent, OTHER);
    } else if (!frame) {
      throw new Refusal('file.unreadable');
    } else if (code === 0x2f) {
      let j = i + 1;
      while (j < length && ENDS_NAME[bytes[j] as number] === 0) j += 1;
      const name = nameOf(bytes, i + 1, j);
      if (frame.arrayDepth === 0 && !frame.expectValue) {
        frame.key = name;
        frame.expectValue = true;
        if (name === 'N') facts.hasN = true;
        else if (name === 'First') facts.hasFirst = true;
        else if (name === 'DecodeParms' || name === 'DP' || name === 'Predictor') {
          facts.hasParms = true;
        }
      } else onValue(result, frame, { kind: 'name', name });
      i = j;
    } else if (code === 0x28) {
      let depth = 0;
      let j = i;
      do {
        const c = bytes[j];
        if (c === 0x5c) j += 1;
        else if (c === 0x28) depth += 1;
        else if (c === 0x29) depth -= 1;
        j += 1;
        if (j - open > MAX_DICTIONARY_CHARS || j > length) throw new Refusal('file.too-complex');
      } while (depth > 0);
      i = j;
      onValue(result, frame, OTHER);
    } else if (code === 0x25) {
      while (i < length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) {
        i += 1;
        if (i - open > MAX_DICTIONARY_CHARS) throw new Refusal('file.too-complex');
      }
    } else if (code === 0x5b) {
      frame.arrayDepth += 1;
      i += 1;
    } else if (code === 0x5d) {
      if (frame.arrayDepth === 0) throw new Refusal('file.unreadable');
      frame.arrayDepth -= 1;
      if (frame.arrayDepth === 0) frame.expectValue = false;
      i += 1;
    } else if (ENDS_NAME[code] === 1) {
      i += 1;
    } else {
      // A number, a keyword (`true`, `null`, `R`): read to the next white space or delimiter.
      let j = i;
      while (j < length && ENDS_NAME[bytes[j] as number] === 0) j += 1;
      if (isDigits(bytes, i, j)) {
        const next = referenceEnd(bytes, j);
        if (next > 0) {
          // `8 0 R`: a reference, not a value written here.
          onValue(result, frame, OTHER);
          j = next;
        } else {
          onValue(result, frame, {
            kind: 'int',
            value: j - i > 9 ? 999_999_999 : Number(bytes.toString('latin1', i, j)),
          });
        }
      } else onValue(result, frame, OTHER);
      i = j;
    }
  }
}

function isDigits(bytes: Buffer, from: number, to: number): boolean {
  let at = from;
  if (bytes[at] === 0x2b || bytes[at] === 0x2d) at += 1;
  if (at >= to) return false;
  for (; at < to; at += 1) {
    const c = bytes[at] as number;
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/** After an integer ends at `from`: where `G R` ends when a reference follows, else 0. */
function referenceEnd(bytes: Buffer, from: number): number {
  const length = bytes.length;
  let at = from;
  while (at < length && isWhite(bytes[at] as number)) at += 1;
  const generation = at;
  while (at < length && (bytes[at] as number) >= 0x30 && (bytes[at] as number) <= 0x39) at += 1;
  if (at === generation) return 0;
  const afterGeneration = at;
  while (at < length && isWhite(bytes[at] as number)) at += 1;
  if (at === afterGeneration || bytes[at] !== 0x52) return 0;
  at += 1;
  return at >= length || ENDS_NAME[bytes[at] as number] === 1 ? at : 0;
}

export type PdfVerdict =
  | { readonly ok: true; readonly pageCount: number }
  | { readonly ok: false; readonly code: DocumentRefusalCode };

/**
 * Checks a PDF by its bytes: it starts with `%PDF-`, ends with `%%EOF` near its end, is not
 * encrypted, holds none of the active names above and has at most {@link MAX_PDF_PAGES} pages
 * (counted by `/Type /Page` objects, or the largest `/Count` of a page tree).
 *
 * The scan covers every name of the whole file, and the streams that could be object streams
 * (any stream with `/N` or `/First`, or `/Type /ObjStm`), where objects can hide. It fails
 * closed: more such streams than {@link MAX_OBJECT_STREAMS}, more inflated bytes than
 * {@link MAX_TOTAL_INFLATED_BYTES}, a filter chain, another filter or a predictor on such a
 * stream, a `/Type` or a page-tree `/Count` that is not written directly, a dictionary that is not
 * read within bounds, or a stream that does not inflate are refused, never accepted unscanned.
 * What a viewer reconstructs from a damaged file is out of reach; the file is only ever served back
 * as a download, never rendered by this server (design 9.4).
 *
 * Synchronous and CPU-bound: the API runs it in a worker thread (`inspectPdfIsolated`). It works on
 * the bytes, never on a string copy of them: memory stays near the size of the input.
 */
export function inspectPdf(input: Uint8Array): PdfVerdict {
  if (detectMediaType(input) !== 'application/pdf') {
    return { ok: false, code: 'file.unsupported-type' };
  }
  try {
    return inspectPdfOrRefuse(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code };
    throw error;
  }
}

function inspectPdfOrRefuse(bytes: Buffer): PdfVerdict {
  const tailFrom = Math.max(0, bytes.length - 2048);
  if (!bytes.subarray(tailFrom).includes('%%EOF')) throw new Refusal('file.unreadable');

  let pages = 0;
  let declared = 0;
  const examine = (content: Buffer, withStreams: boolean): ScanResult => {
    scanNames(content);
    const found = scanDictionaries(content, withStreams);
    pages += found.pages;
    declared = Math.max(declared, found.declared);
    return found;
  };

  const top = examine(bytes, true);
  let budget = MAX_TOTAL_INFLATED_BYTES;
  for (const range of top.streams) {
    const data = bytes.subarray(range.start, range.end);
    if (!range.flate) {
      examine(data, false);
      continue;
    }
    if (budget <= 0) throw new Refusal('file.too-complex');
    let inflated: Buffer;
    try {
      inflated = inflateSync(data, {
        maxOutputLength: Math.min(MAX_STREAM_INFLATED_BYTES, budget),
      });
    } catch (error) {
      const tooBig = (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
      throw new Refusal(tooBig ? 'file.too-complex' : 'file.unreadable');
    }
    budget -= inflated.length;
    examine(inflated, false);
  }

  const pageCount = Math.max(pages, declared);
  if (pageCount < 1) return { ok: false, code: 'file.unreadable' };
  if (pageCount > MAX_PDF_PAGES) return { ok: false, code: 'file.too-many-pages' };
  return { ok: true, pageCount };
}
