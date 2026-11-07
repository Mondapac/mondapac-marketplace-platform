// A small, bounded ZIP reader for the photo step of the seller import (catalog design 14c, "Photos").
// The panel opens the archive in the browser; the server never receives or opens a ZIP. Only what
// photos need is read: stored (method 0) and deflate (method 8) entries of a single-disk, plain
// archive. Everything else is refused with its own code. Every limit is checked on the declared
// numbers first and again on the bytes that actually come out of the inflater.

/** Why an archive was refused. Each code has its own message on the page. */
export type ZipErrorCode =
  | 'too-big'
  | 'too-many-entries'
  | 'unsupported-compression'
  | 'encrypted'
  | 'zip64'
  | 'multi-disk'
  | 'broken'
  | 'duplicate-name'
  | 'not-image'
  | 'entry-too-big'
  | 'total-too-big';

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

export interface ZipLimits {
  /** The archive file itself. */
  readonly maxZipBytes: number;
  /** Entries that are kept (directories, `__MACOSX` and dot-files do not count). */
  readonly maxEntries: number;
  /** One entry, uncompressed. */
  readonly maxEntryBytes: number;
  /** All kept entries together, uncompressed. */
  readonly maxTotalBytes: number;
}

/** One kept entry: its base name (no folder) and its bytes. */
export interface ZipFileEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Decides whether a base name is wanted; a `false` ends the read with `not-image`. */
export type ZipNameCheck = (baseName: string) => boolean;
/** Decides from the first bytes whether the content is what the name says; `false` is `not-image`. */
export type ZipContentCheck = (baseName: string, bytes: Uint8Array) => boolean;

interface CentralEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
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
/** A deflate stream is never much larger than its content; this is the slack over the entry cap. */
const COMPRESSED_SLACK = 1024 * 1024;

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
export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
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

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reads the central directory and checks every kept entry against the limits and the name rules
 * without inflating anything.
 */
async function listEntries(
  zip: Blob,
  limits: ZipLimits,
  isWantedName: ZipNameCheck,
): Promise<CentralEntry[]> {
  if (zip.size > limits.maxZipBytes) throw new ZipError('too-big');
  if (zip.size < EOCD_SIZE) throw new ZipError('broken');

  const tailStart = Math.max(0, zip.size - (EOCD_SIZE + MAX_COMMENT));
  const tail = await readBytes(zip.slice(tailStart, zip.size));
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let at = tail.length - EOCD_SIZE; at >= 0; at -= 1) {
    if (
      tailView.getUint32(at, true) === EOCD_SIGNATURE &&
      at + EOCD_SIZE + tailView.getUint16(at + 20, true) <= tail.length
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
  if (total === 0) return [];
  if (total > limits.maxEntries * RECORDS_PER_KEPT_ENTRY) throw new ZipError('too-many-entries');

  const eocdAt = tailStart + eocd;
  if (directoryOffset + directorySize > eocdAt || directorySize < total * CENTRAL_FIXED) {
    throw new ZipError('broken');
  }
  const directory = await readBytes(zip.slice(directoryOffset, directoryOffset + directorySize));
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let at = 0;
  for (let index = 0; index < total; index += 1) {
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
    const path = decodeEntryName(
      directory.subarray(at + CENTRAL_FIXED, at + CENTRAL_FIXED + nameLength),
      (flags & 0x0800) !== 0,
    );
    at = next;

    if (isIgnoredPath(path.replaceAll('\\', '/'))) continue;
    const name = baseNameOf(path);
    if (name === '' || hasControlCharacter(name)) throw new ZipError('broken');

    // Encryption (bit 0, strong encryption bit 6, WinZip AES method 99) before anything else.
    if ((flags & 0x0041) !== 0 || method === 99) throw new ZipError('encrypted');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64');
    }
    if (startDisk !== 0) throw new ZipError('multi-disk');
    if (method !== 0 && method !== 8) throw new ZipError('unsupported-compression', name);

    if (entries.length >= limits.maxEntries) throw new ZipError('too-many-entries');
    if (!isWantedName(name)) throw new ZipError('not-image', name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError('duplicate-name', name);
    seen.add(key);
    if (size > limits.maxEntryBytes || compressedSize > limits.maxEntryBytes + COMPRESSED_SLACK) {
      throw new ZipError('entry-too-big', name);
    }
    if (method === 0 && compressedSize !== size) throw new ZipError('broken');
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError('total-too-big');
    if (localOffset + LOCAL_FIXED + compressedSize > directoryOffset) throw new ZipError('broken');
    entries.push({ name, method, crc, compressedSize, size, localOffset });
  }
  return entries;
}

/**
 * Inflates raw deflate data and stops at once when more than `cap` bytes come out, whatever the
 * entry declared (a zip bomb lies about its size).
 */
async function inflate(
  data: Uint8Array,
  cap: number,
  entryName: string,
  totalSoFar: number,
  maxTotal: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new ZipError('unsupported-compression');
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
  let length = 0;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done) break;
      if (value === undefined) continue;
      length += value.length;
      if (length > cap) throw new ZipError('entry-too-big', entryName);
      if (totalSoFar + length > maxTotal) throw new ZipError('total-too-big');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ZipError) throw error;
    throw new ZipError('broken');
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The kept entries of a ZIP, one inflated at a time. `isWantedName` and `isWantedContent` let the
 * caller refuse an entry that is not what it asked for. Any refusal throws a {@link ZipError};
 * nothing is returned for a partly good archive.
 */
export async function readZipEntries(
  zip: Blob,
  limits: ZipLimits,
  isWantedName: ZipNameCheck,
  isWantedContent: ZipContentCheck,
): Promise<ZipFileEntry[]> {
  const entries = await listEntries(zip, limits, isWantedName);
  const out: ZipFileEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    const header = await readBytes(zip.slice(entry.localOffset, entry.localOffset + LOCAL_FIXED));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.length < LOCAL_FIXED || view.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new ZipError('broken');
    }
    const start =
      entry.localOffset + LOCAL_FIXED + view.getUint16(26, true) + view.getUint16(28, true);
    if (start + entry.compressedSize > zip.size) throw new ZipError('broken');
    const raw = await readBytes(zip.slice(start, start + entry.compressedSize));
    const bytes =
      entry.method === 0
        ? raw
        : await inflate(raw, limits.maxEntryBytes, entry.name, total, limits.maxTotalBytes);
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new ZipError('broken');
    if (!isWantedContent(entry.name, bytes)) throw new ZipError('not-image', entry.name);
    total += bytes.length;
    out.push({ name: entry.name, bytes });
  }
  return out;
}
