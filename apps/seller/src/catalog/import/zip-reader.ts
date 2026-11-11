// A small, bounded ZIP reader for the photo step of the seller import (catalog design 14c, "Photos").
// The panel opens the archive in the browser; the server never receives or opens a ZIP. Only what
// photos need is read: stored (method 0) and deflate (method 8) entries of a single-disk, plain
// archive. The structure is checked the way the 14a server guard checks an XLSX
// (`infrastructure/xlsx/zip-inspection.ts`): the end record sits at the very end, the directory
// ends exactly where the end record starts, local headers agree with the directory, and no entry
// overlaps another or reaches into the directory. Every limit is checked on the declared numbers
// first and again on the bytes that come out of the inflater.
//
// Refused whole: a structural fault, a header that lies, anything unsupported, a duplicate name.
// Skipped and counted: an entry that is honestly not a picture, or honestly over the size cap.

/** Why an archive was refused. Each code has its own message on the page. */
export type ZipErrorCode =
  | 'too-big'
  | 'total-too-big'
  | 'too-many-entries'
  | 'unsupported-compression'
  | 'unsupported-browser'
  | 'encrypted'
  | 'zip64'
  | 'multi-disk'
  | 'broken'
  | 'duplicate-name';

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  /** The entry's base name, when the refusal is about one entry. */
  readonly entry: string | null;

  constructor(code: ZipErrorCode, entry: string | null = null) {
    super(entry === null ? `zip.${code}` : `zip.${code}: ${entry}`);
    this.name = 'ZipError';
    this.code = code;
    this.entry = entry;
  }
}

/** The seller pressed Cancel; not a refusal. */
export class ZipCancelled extends Error {
  constructor() {
    super('zip.cancelled');
    this.name = 'ZipCancelled';
  }
}

export interface ZipLimits {
  /** The archive file itself. */
  readonly maxZipBytes: number;
  /** Entries that are kept (directories, hidden files and skipped entries do not count). */
  readonly maxEntries: number;
  /** One entry, uncompressed; an entry declared over it is skipped. */
  readonly maxEntryBytes: number;
  /** All kept entries together, uncompressed. */
  readonly maxTotalBytes: number;
}

export interface ZipReadOptions {
  /** True for a base name that is wanted; any other entry is skipped and counted. */
  readonly isWantedName: (baseName: string) => boolean;
  /** True when the first bytes show what the name says; any other entry is skipped and counted. */
  readonly isWantedContent: (head: Uint8Array) => boolean;
  readonly signal?: AbortSignal;
}

/** One kept entry: its base name, its content as a blob (no copy for a stored entry) and its head. */
export interface ZipFileEntry {
  readonly name: string;
  readonly blob: Blob;
  readonly head: Uint8Array;
}

export interface ZipRead {
  readonly entries: readonly ZipFileEntry[];
  /** Entries left out because they are not pictures (by name or by content). */
  readonly notImage: number;
  /** Entries left out because they are declared over the per-entry cap. */
  readonly tooBig: number;
}

interface CentralEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  /** Where the data starts and ends, after the local header was checked. */
  dataStart: number;
  dataEnd: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_FIXED = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_FIXED = 30;
const MAX_COMMENT = 0xffff;
/** The most central-directory records read, whatever they hold (a parse bound, not a photo count). */
const RECORDS_PER_KEPT_ENTRY = 4;
/** What one directory record may take besides its fixed part: a name budget. */
const RECORD_NAME_BUDGET = 1024;
/** A deflate stream is never much larger than its content; this is the slack over the entry cap. */
const COMPRESSED_SLACK = 1024 * 1024;
const HEAD_BYTES = 16;

const CP437_UPPER =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** An entry name: UTF-8 when general-purpose bit 11 is set, otherwise code page 437. */
export function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  for (const byte of bytes)
    out += byte < 0x80 ? String.fromCharCode(byte) : CP437_UPPER[byte - 0x80];
  return out;
}

let crcTable: Uint32Array | null = null;
function crcUpdate(state: number, bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = state;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return crc;
}

export function crc32(bytes: Uint8Array): number {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/** Bytes of a blob. `Blob.arrayBuffer` where it exists, a FileReader where it does not. */
async function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new ZipError('broken'));
    reader.readAsArrayBuffer(blob);
  });
}

/** Skipped without a word: folders, macOS resource forks, and hidden files or folders. */
export function isIgnoredPath(path: string): boolean {
  if (path.endsWith('/')) return true;
  return path
    .split('/')
    .some((part) => part === '__MACOSX' || (part.startsWith('.') && part !== '.' && part !== '..'));
}

/** The last part of a path, whichever slash the archive's maker used. */
function baseNameOf(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts[parts.length - 1] ?? '';
}

/** C0 and C1 controls, and the characters that reorder or hide text (bidi overrides and marks). */
function hasUnsafeCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x061c || code === 0x200e || code === 0x200f) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ZipCancelled();
}

/** Checks a local header against the directory entry and fills in where its data lies. */
async function checkLocalHeader(
  zip: Blob,
  entry: CentralEntry,
  directoryOffset: number,
): Promise<void> {
  if (entry.localOffset + LOCAL_FIXED > directoryOffset) throw new ZipError('broken');
  const header = await readBytes(zip.slice(entry.localOffset, entry.localOffset + LOCAL_FIXED));
  if (header.length < LOCAL_FIXED) throw new ZipError('broken');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LOCAL_SIGNATURE) throw new ZipError('broken');
  if (view.getUint16(8, true) !== entry.method) throw new ZipError('broken');
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const nameStart = entry.localOffset + LOCAL_FIXED;
  const dataStart = nameStart + nameLength + extraLength;
  // The data, with the local name and extra field, must end before the directory starts.
  if (dataStart + entry.compressedSize > directoryOffset) throw new ZipError('broken');
  const localName = await readBytes(zip.slice(nameStart, nameStart + nameLength));
  if (!equalBytes(localName, entry.nameBytes)) throw new ZipError('broken');
  entry.dataStart = dataStart;
  entry.dataEnd = dataStart + entry.compressedSize;
}

interface Listing {
  readonly entries: CentralEntry[];
  readonly notImage: number;
  readonly tooBig: number;
}

/**
 * Reads the central directory and checks every kept entry against the limits and the structure
 * rules without inflating anything.
 */
async function listEntries(
  zip: Blob,
  limits: ZipLimits,
  options: ZipReadOptions,
): Promise<Listing> {
  if (zip.size > limits.maxZipBytes) throw new ZipError('too-big');
  if (zip.size < EOCD_SIZE) throw new ZipError('broken');

  const tailStart = Math.max(0, zip.size - (EOCD_SIZE + MAX_COMMENT));
  const tail = await readBytes(zip.slice(tailStart, zip.size));
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let at = tail.length - EOCD_SIZE; at >= 0; at -= 1) {
    // The end record is the one whose comment runs exactly to the end of the file.
    if (
      tailView.getUint32(at, true) === EOCD_SIGNATURE &&
      at + EOCD_SIZE + tailView.getUint16(at + 20, true) === tail.length
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('broken');

  const disk = tailView.getUint16(eocd + 4, true);
  const directoryDisk = tailView.getUint16(eocd + 6, true);
  const onDisk = tailView.getUint16(eocd + 8, true);
  const total = tailView.getUint16(eocd + 10, true);
  const directorySize = tailView.getUint32(eocd + 12, true);
  const directoryOffset = tailView.getUint32(eocd + 16, true);

  const hasLocator = eocd >= 20 && tailView.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE;
  if (
    hasLocator ||
    total === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new ZipError('zip64');
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) throw new ZipError('multi-disk');
  const maxRecords = limits.maxEntries * RECORDS_PER_KEPT_ENTRY;
  if (total > maxRecords) throw new ZipError('too-many-entries');
  if (directorySize > maxRecords * (CENTRAL_FIXED + RECORD_NAME_BUDGET)) {
    throw new ZipError('too-many-entries');
  }

  const eocdAt = tailStart + eocd;
  // The directory ends exactly where the end record starts (a fake end record in a comment fails).
  if (directoryOffset + directorySize !== eocdAt || directorySize < total * CENTRAL_FIXED) {
    throw new ZipError('broken');
  }
  if (total === 0) return { entries: [], notImage: 0, tooBig: 0 };
  const directory = await readBytes(zip.slice(directoryOffset, directoryOffset + directorySize));
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let notImage = 0;
  let tooBig = 0;
  let declaredTotal = 0;
  let at = 0;
  for (let index = 0; index < total; index += 1) {
    throwIfCancelled(options.signal);
    if (at + CENTRAL_FIXED > directory.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('broken');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const startDisk = view.getUint16(at + 34, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_FIXED + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new ZipError('broken');
    const nameBytes = directory.subarray(at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLength);
    const path = decodeEntryName(nameBytes, (flags & 0x0800) !== 0);
    at = next;

    if (isIgnoredPath(path.replaceAll('\\', '/'))) continue;
    const name = baseNameOf(path).normalize('NFC');
    if (name === '' || hasUnsafeCharacter(name)) throw new ZipError('broken');

    // Not a picture by its name: never opened, only counted.
    if (!options.isWantedName(name)) {
      notImage += 1;
      continue;
    }

    // Encryption (bit 0, strong encryption bit 6, WinZip AES method 99) before anything else.
    if ((flags & 0x0041) !== 0 || method === 99) throw new ZipError('encrypted');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64');
    }
    if (startDisk !== 0) throw new ZipError('multi-disk');
    if (method !== 0 && method !== 8) throw new ZipError('unsupported-compression', name);

    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError('duplicate-name', name);
    seen.add(key);

    // Honestly too big: left out. (A header that lies about it is caught when it is inflated.)
    if (size > limits.maxEntryBytes) {
      tooBig += 1;
      continue;
    }
    if (compressedSize > limits.maxEntryBytes + COMPRESSED_SLACK) throw new ZipError('broken');
    if (entries.length >= limits.maxEntries) throw new ZipError('too-many-entries');
    if (method === 0 && compressedSize !== size) throw new ZipError('broken');
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError('total-too-big');
    entries.push({
      name,
      nameBytes: Uint8Array.from(nameBytes),
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      dataStart: 0,
      dataEnd: 0,
    });
  }
  if (at !== directory.length) throw new ZipError('broken');

  for (const entry of entries) {
    throwIfCancelled(options.signal);
    await checkLocalHeader(zip, entry, directoryOffset);
  }
  // No two entries share a byte (one set of bytes read as two photos).
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < byOffset.length; index += 1) {
    const previous = byOffset[index - 1] as CentralEntry;
    if (previous.dataEnd > (byOffset[index] as CentralEntry).localOffset) {
      throw new ZipError('broken');
    }
  }
  return { entries, notImage, tooBig };
}

interface Inflated {
  readonly blob: Blob;
  readonly head: Uint8Array;
}

/**
 * Inflates raw deflate data. The entry declared its size, so one byte more than that is a lie and
 * ends the read at once; nothing is kept as one big array, the chunks go straight into a blob.
 */
async function inflate(
  data: Uint8Array,
  entry: CentralEntry,
  signal: AbortSignal | undefined,
): Promise<Inflated> {
  if (typeof DecompressionStream === 'undefined') throw new ZipError('unsupported-browser');
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(
      new DecompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>,
    )
    .getReader();
  const chunks: Uint8Array[] = [];
  const head = new Uint8Array(HEAD_BYTES);
  let headLength = 0;
  let length = 0;
  let crc = 0xffffffff;
  try {
    for (;;) {
      throwIfCancelled(signal);
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done) break;
      if (value === undefined) continue;
      length += value.length;
      if (length > entry.size) throw new ZipError('broken');
      crc = crcUpdate(crc, value);
      if (headLength < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - headLength, value.length);
        head.set(value.subarray(0, take), headLength);
        headLength += take;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ZipError || error instanceof ZipCancelled) throw error;
    throw new ZipError('broken');
  }
  if (length !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
    throw new ZipError('broken');
  }
  return { blob: new Blob(chunks as BlobPart[]), head: head.subarray(0, headLength) };
}

/**
 * The kept entries of a ZIP, one inflated at a time. A refusal throws a {@link ZipError}; nothing is
 * returned for a partly good archive. Entries that are not pictures, or honestly too big, are
 * counted, not read.
 */
export async function readZip(
  zip: Blob,
  limits: ZipLimits,
  options: ZipReadOptions,
): Promise<ZipRead> {
  const listing = await listEntries(zip, limits, options);
  const out: ZipFileEntry[] = [];
  let notImage = listing.notImage;
  for (const entry of listing.entries) {
    throwIfCancelled(options.signal);
    const raw = await readBytes(zip.slice(entry.dataStart, entry.dataEnd));
    let blob: Blob;
    let head: Uint8Array;
    if (entry.method === 0) {
      if (crc32(raw) !== entry.crc) throw new ZipError('broken');
      // A stored entry is a view of the ZIP file itself: no second copy of the picture.
      blob = zip.slice(entry.dataStart, entry.dataEnd);
      head = raw.subarray(0, HEAD_BYTES);
    } else {
      ({ blob, head } = await inflate(raw, entry, options.signal));
    }
    if (!options.isWantedContent(head)) {
      notImage += 1;
      continue;
    }
    out.push({ name: entry.name, blob, head: Uint8Array.from(head) });
  }
  return { entries: out, notImage, tooBig: listing.tooBig };
}
