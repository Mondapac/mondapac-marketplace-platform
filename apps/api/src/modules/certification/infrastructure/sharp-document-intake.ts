import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import sharp from 'sharp';
import {
  detectMediaType,
  MAX_DOCUMENT_BYTES,
  type DocumentRefusalCode,
} from '../application/intake/document-inspection';
import { inspectPdfIsolated } from './isolated-pdf-inspection';
import type { DocumentIntake, InspectedDocument } from '../application/ports/document-ports';

/** 40 megapixels (design 5.1, decision row 8). */
const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 20_000;
/** Decodes that may run at once in this process (the catalog photo rule). */
const MAX_CONCURRENT = 2;
const JPEG_QUALITY = 90;

type Refusal = { readonly code: DocumentRefusalCode };

sharp.concurrency(1);
sharp.cache(false);

let running = 0;
const waiting: (() => void)[] = [];
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

/**
 * {@link DocumentIntake} on sharp and the PDF byte scan (certification design 9.3, simplified for
 * the first release). The type comes from the first bytes only (JPEG, PNG, PDF; HEIC is refused as
 * an unsupported type). A JPEG or PNG is decoded with `failOn: 'error'`, bounded in pixels, refused
 * when it is animated or multi-page or when its decoded format is not the one its first bytes
 * claim (a polyglot), and written again from its pixels in the same format: sharp writes no
 * metadata unless asked, so EXIF, GPS, ICC profiles and embedded thumbnails of the upload are gone.
 * A PDF is checked by {@link inspectPdf} and kept as received. Nothing about the upload's name or
 * declared type is read. No scanner, no sandbox and no preview in this release.
 */
export class SharpDocumentIntake implements DocumentIntake {
  inspect(bytes: Buffer): Promise<Result<InspectedDocument, Refusal>> {
    if (bytes.length === 0) return Promise.resolve(err({ code: 'file.unreadable' }));
    if (bytes.length > MAX_DOCUMENT_BYTES) return Promise.resolve(err({ code: 'file.too-large' }));
    const mediaType = detectMediaType(bytes);
    if (mediaType === null) return Promise.resolve(err({ code: 'file.unsupported-type' }));
    if (mediaType === 'application/pdf') {
      // The same concurrency limit as the images; the scan itself runs in a worker thread.
      return withSlot(async () => {
        const verdict = await inspectPdfIsolated(bytes);
        return verdict.ok
          ? ok({ mediaType, bytes, pageCount: verdict.pageCount })
          : err({ code: verdict.code });
      });
    }
    return withSlot(() => this.#image(bytes, mediaType));
  }

  async #image(
    bytes: Buffer,
    mediaType: 'image/jpeg' | 'image/png',
  ): Promise<Result<InspectedDocument, Refusal>> {
    try {
      const open = () =>
        sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false });
      const meta = await open().metadata();
      const expected = mediaType === 'image/jpeg' ? 'jpeg' : 'png';
      if (meta.format !== expected) return err({ code: 'file.unsupported-type' });
      if ((meta.pages ?? 1) > 1) return err({ code: 'file.unsupported-type' });
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width < 1 || height < 1) return err({ code: 'file.unreadable' });
      if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
        return err({ code: 'file.unreadable' });
      }
      const pipeline = open().rotate();
      const written =
        mediaType === 'image/jpeg'
          ? await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
          : await pipeline.png({ compressionLevel: 9 }).toBuffer();
      if (written.length > MAX_DOCUMENT_BYTES * 2) return err({ code: 'file.too-large' });
      return ok({ mediaType, bytes: written, pageCount: null });
    } catch {
      return err({ code: 'file.unreadable' });
    }
  }
}
