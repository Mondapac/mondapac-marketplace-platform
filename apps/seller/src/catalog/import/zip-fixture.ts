// Test helper: builds small ZIP archives byte by byte, including broken and hostile ones. Not used by
// the page.

import { deflateRawSync } from 'node:zlib';
import { crc32 } from './zip-reader.ts';

export interface FixtureEntry {
  readonly name: string;
  readonly data?: Uint8Array;
  /** 0 stored, 8 deflate (default), or any number to write as is. */
  readonly method?: number;
  /** Raw name bytes, instead of the UTF-8 of `name`. */
  readonly nameBytes?: Uint8Array;
  readonly utf8?: boolean;
  /** Extra general-purpose flag bits (1 = encrypted). */
  readonly flags?: number;
  /** Written into the headers instead of the real uncompressed size. */
  readonly declaredSize?: number;
  /** Written into the headers instead of the real compressed size. */
  readonly declaredCompressedSize?: number;
  /** Written as the local header offset when set. */
  readonly localOffset?: number;
  /** Name bytes written in the local header only. */
  readonly localNameBytes?: Uint8Array;
  /** Method written in the local header only. */
  readonly localMethod?: number;
  /** Compressed bytes to use instead of compressing `data`. */
  readonly compressed?: Uint8Array;
}

export interface FixtureOptions {
  readonly comment?: string;
  readonly disk?: number;
  readonly totalOverride?: number;
  readonly zip64Locator?: boolean;
}

const encoder = new TextEncoder();

export const JPEG = (extra = 8): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: extra }, (_, i) => i)]);
export const PNG = (): Uint8Array =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const WEBP = (): Uint8Array =>
  Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}
function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function buildZip(
  entries: readonly FixtureEntry[],
  options: FixtureOptions = {},
): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array();
    const method = entry.method ?? 8;
    const body = entry.compressed ?? (method === 8 ? deflateRawSync(data) : data);
    const nameBytes = entry.nameBytes ?? encoder.encode(entry.name);
    const localName = entry.localNameBytes ?? nameBytes;
    const flags = (entry.flags ?? 0) | (entry.utf8 === false ? 0 : 0x0800);
    const crc = crc32(data);
    const size = entry.declaredSize ?? data.length;
    const compressedSize = entry.declaredCompressedSize ?? body.length;
    const offset = parts.length;
    parts.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(flags),
      ...u16(entry.localMethod ?? method),
      ...u32(0),
      ...u32(crc),
      ...u32(compressedSize),
      ...u32(size),
      ...u16(localName.length),
      ...u16(0),
      ...localName,
      ...body,
    );
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(flags),
      ...u16(method),
      ...u32(0),
      ...u32(crc),
      ...u32(compressedSize),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(entry.localOffset ?? offset),
      ...nameBytes,
    );
  }
  const directoryOffset = parts.length;
  const out = [...parts, ...central];
  if (options.zip64Locator) out.push(...u32(0x07064b50), ...new Array<number>(16).fill(0));
  const comment = encoder.encode(options.comment ?? '');
  const total = options.totalOverride ?? entries.length;
  out.push(
    ...u32(0x06054b50),
    ...u16(options.disk ?? 0),
    ...u16(0),
    ...u16(total),
    ...u16(total),
    ...u32(central.length),
    ...u32(directoryOffset),
    ...u16(comment.length),
    ...comment,
  );
  return Uint8Array.from(out);
}

export const zipFile = (bytes: Uint8Array, name = 'photos.zip'): File =>
  new File([bytes as BlobPart], name, { type: 'application/zip' });
