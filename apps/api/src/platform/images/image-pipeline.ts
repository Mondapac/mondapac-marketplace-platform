import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import sharp from 'sharp';

/** Why an upload was refused; codes only, never a file name or content. */
export type ImageRefusalCode =
  | 'file.unsupported-type'
  | 'file.too-large'
  | 'file.too-many-pixels'
  | 'file.too-small'
  | 'file.unreadable'
  /** Too many pictures are being processed already: nothing was decoded, try again shortly. */
  | 'file.busy';

/**
 * One output size. `inside` fits the picture in the box without enlarging it; `cover` fills the
 * box and crops the overflow at the centre; `contain` puts the whole picture in the middle of a
 * white box of the same shape. `cover` and `contain` never enlarge either: the box shrinks, in
 * its own proportions, until the upload is big enough to fill it.
 */
export interface RenditionSpec {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fit: 'inside' | 'cover' | 'contain';
}

/** What a caller asks of the pipeline: the largest accepted upload, its least size and the outputs. */
export interface ImagePipelineSpec {
  readonly maxUploadBytes: number;
  /** The longest side of the upload must be at least this (a photo). */
  readonly minLongestSide?: number;
  /** Both of these, after the orientation is applied (a logo, a banner). */
  readonly minWidth?: number;
  readonly minHeight?: number;
  /**
   * The outputs, largest first: the upload is decoded once for the first, and each later one is
   * made from the output before it.
   */
  readonly renditions: readonly RenditionSpec[];
}

export interface ProcessedImageRendition {
  readonly name: string;
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

const MAX_SIDE = 12000;
const MAX_PIXELS = 24_000_000;
/** Decodes that may run at once in this process (Hassan M1). */
const MAX_CONCURRENT = 2;
/** Uploads that may wait for a decode slot; one more is refused before it is decoded (Hassan H2). */
const MAX_WAITING = 8;
/** The wait the callers announce with a busy refusal, in seconds. */
export const IMAGE_BUSY_RETRY_SECONDS = 2;
const ALLOWED = new Set(['jpeg', 'png', 'webp']);
const JPEG_QUALITY = 82;
const WHITE = '#ffffff';

sharp.concurrency(1);
sharp.cache(false);

/** JPEG, PNG or WebP signature: other formats never reach the decoder (Hassan L1). */
function hasAllowedSignature(bytes: Buffer): boolean {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp =
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
}

let running = 0;
const waiting: (() => void)[] = [];

/** True when every slot is taken and the waiting queue is full: the next upload is refused. */
function isSaturated(): boolean {
  return running >= MAX_CONCURRENT && waiting.length >= MAX_WAITING;
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

const scaled = (side: number, factor: number): number => Math.max(1, Math.round(side * factor));

/** The box a `cover` or `contain` output really has for a source of this size (never enlarging). */
function boxFor(spec: RenditionSpec, width: number, height: number): { w: number; h: number } {
  if (spec.fit === 'cover') {
    const factor = Math.min(1, width / spec.width, height / spec.height);
    return { w: scaled(spec.width, factor), h: scaled(spec.height, factor) };
  }
  const factor = Math.min(1, Math.max(width / spec.width, height / spec.height));
  return { w: scaled(spec.width, factor), h: scaled(spec.height, factor) };
}

/**
 * The shared core of the image uploads (catalog photos, store logos and banners). The type comes
 * from the decoded content (the upload's name and declared type are never read). Decoding is
 * bounded by `limitInputPixels`, a damaged file fails (`failOn: 'error'`), an animated or
 * multi-page file is refused, orientation is applied, and each rendition is a fresh JPEG: sharp
 * writes no metadata unless asked, so EXIF, GPS, ICC profiles and embedded thumbnails of the upload
 * are gone. Transparent pixels are flattened onto white. At most {@link MAX_CONCURRENT} decodes
 * run and {@link MAX_WAITING} wait for a slot; past that the upload is refused as `file.busy`
 * before any decoding (a flood of uploads cannot queue unbounded buffers).
 */
export function processImage(
  bytes: Buffer,
  spec: ImagePipelineSpec,
): Promise<Result<readonly ProcessedImageRendition[], { readonly code: ImageRefusalCode }>> {
  if (bytes.length === 0) return Promise.resolve(err({ code: 'file.unreadable' }));
  if (bytes.length > spec.maxUploadBytes) return Promise.resolve(err({ code: 'file.too-large' }));
  if (!hasAllowedSignature(bytes)) return Promise.resolve(err({ code: 'file.unsupported-type' }));
  if (isSaturated()) return Promise.resolve(err({ code: 'file.busy' }));
  return withSlot(() => decode(bytes, spec));
}

async function decode(
  bytes: Buffer,
  spec: ImagePipelineSpec,
): Promise<Result<readonly ProcessedImageRendition[], { readonly code: ImageRefusalCode }>> {
  try {
    const open = () =>
      sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false });
    const meta = await open().metadata();
    if (meta.format === undefined || !ALLOWED.has(meta.format)) {
      return err({ code: 'file.unsupported-type' });
    }
    if ((meta.pages ?? 1) > 1) return err({ code: 'file.unsupported-type' });
    const rawWidth = meta.width ?? 0;
    const rawHeight = meta.height ?? 0;
    if (rawWidth < 1 || rawHeight < 1) return err({ code: 'file.unreadable' });
    if (rawWidth > MAX_SIDE || rawHeight > MAX_SIDE || rawWidth * rawHeight > MAX_PIXELS) {
      return err({ code: 'file.too-many-pixels' });
    }
    // Orientations 5 to 8 turn the picture a quarter: the shown width is the stored height.
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? rawHeight : rawWidth;
    const height = turned ? rawWidth : rawHeight;
    if (
      (spec.minLongestSide !== undefined && Math.max(width, height) < spec.minLongestSide) ||
      (spec.minWidth !== undefined && width < spec.minWidth) ||
      (spec.minHeight !== undefined && height < spec.minHeight)
    ) {
      return err({ code: 'file.too-small' });
    }

    const renditions: ProcessedImageRendition[] = [];
    // The upload is decoded once, for the first rendition; the later ones come from the output
    // before them.
    let source: { readonly bytes: Buffer; readonly width: number; readonly height: number } | null =
      null;
    for (const rendition of spec.renditions) {
      const from = source ?? { bytes, width, height };
      const pipeline: sharp.Sharp = source === null ? open().rotate() : sharp(source.bytes);
      let resized: sharp.Sharp;
      if (rendition.fit === 'inside') {
        resized = pipeline.resize({
          width: rendition.width,
          height: rendition.height,
          fit: 'inside',
          withoutEnlargement: true,
        });
      } else {
        const box = boxFor(rendition, from.width, from.height);
        resized = pipeline.resize({
          width: box.w,
          height: box.h,
          fit: rendition.fit,
          position: 'centre',
          background: WHITE,
        });
      }
      const { data, info } = await resized
        .flatten({ background: WHITE })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer({ resolveWithObject: true });
      renditions.push({
        name: rendition.name,
        bytes: data,
        width: info.width,
        height: info.height,
      });
      source = { bytes: data, width: info.width, height: info.height };
    }
    return ok(renditions);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit|exceeds/i.test(message)) return err({ code: 'file.too-many-pixels' });
    if (/unsupported image format/i.test(message)) return err({ code: 'file.unsupported-type' });
    return err({ code: 'file.unreadable' });
  }
}
