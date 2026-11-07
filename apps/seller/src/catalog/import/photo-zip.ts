// The ZIP source of the photo step (catalog design 14c, "Photos"): the seller gives the photos as one
// ZIP, the panel opens it in the browser, and the pictures end in `pickPhotos` like files picked one
// by one. The server never receives the ZIP. The limits are the page's own where it has one.

import { PHOTO_MAX_INPUT_BYTES } from '../photo-limits.ts';
import { MAX_PICKED_PHOTOS, PHOTO_EXTENSION } from './photo-queue.ts';
import { readZipEntries, type ZipLimits } from './zip-reader.ts';

const MIB = 1024 * 1024;

/**
 * The ZIP file: one budget for all the photos in it. Photos hardly compress, so the archive is
 * about as large as its pictures; this is the most the tab is asked to hold at once.
 */
export const MAX_ZIP_BYTES = 512 * MIB;
/** All pictures together once unzipped: twice the archive, which also stops a zip bomb early. */
export const MAX_ZIP_TOTAL_BYTES = 1024 * MIB;

export const PHOTO_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: MAX_ZIP_BYTES,
  // The same count as picked files, and the same size the page accepts for one picked photo.
  maxEntries: MAX_PICKED_PHOTOS,
  maxEntryBytes: PHOTO_MAX_INPUT_BYTES,
  maxTotalBytes: MAX_ZIP_TOTAL_BYTES,
};

export const ZIP_ACCEPT = '.zip,application/zip,application/x-zip-compressed';

type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** The picture type the first bytes show, or null. The name alone is not trusted. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (index: number) => bytes[index];
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => at(index) === byte)
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * The pictures in a ZIP as files named by their base name, ready for `pickPhotos`. Throws a
 * `ZipError` for the first problem; a ZIP is taken whole or not at all.
 */
export async function unzipPhotos(
  zip: Blob,
  limits: ZipLimits = PHOTO_ZIP_LIMITS,
): Promise<File[]> {
  const entries = await readZipEntries(
    zip,
    limits,
    (name) => PHOTO_EXTENSION.test(name),
    (_name, bytes) => sniffImage(bytes) !== null,
  );
  return entries.map(
    (entry) =>
      new File([entry.bytes as BlobPart], entry.name, { type: sniffImage(entry.bytes) ?? '' }),
  );
}
