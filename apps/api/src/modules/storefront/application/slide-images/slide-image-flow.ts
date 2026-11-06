import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../../platform/images/image-pipeline';
import { StorefrontSlideImageUploaded } from '../../domain/audit';
import { problem, type Problems } from '../../domain/fields';
import { adminOf } from '../page-flow';
import type { StoredSlideRendition } from '../ports/slide-image.store';
import type { SlideImageRefusalCode } from '../ports/slide-image-processor';
import type { StorefrontDependencies } from '../storefront-dependencies';
import {
  MAX_SLIDE_UPLOAD_BYTES,
  isSlideImageSize,
  removeObjects,
  slideImageObjectKey,
} from './slide-image';

// The slide image library (file storage pilot F9): an editor uploads a wide desktop picture and,
// if wanted, a separate tall mobile one; a slide names the result by `content.image.ref`. Anyone
// may read a rendition by its unguessable id (marketing pictures, cached a few minutes).

const logger = new Logger('StorefrontSlideImage');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type SlideImageFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable'; readonly retryAfterSeconds?: number }
  | { readonly code: 'validation.failed'; readonly fields: Problems }
  | { readonly code: Exclude<SlideImageRefusalCode, 'file.busy'> }
  | { readonly code: 'storefront.slide-image-not-found' };

export interface SlideImageView {
  readonly imageId: Id<'SlideImage'>;
  readonly hasMobile: boolean;
  readonly width: number;
  readonly height: number;
}

export interface SlideImageBytes {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

/** Checks one base64 field; null when the field is fine. */
function badBase64(fields: Problems, name: string, value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0) {
    problem(fields, name, value === undefined ? 'required' : 'type');
    return null;
  }
  if (value.length > Math.ceil((MAX_SLIDE_UPLOAD_BYTES * 4) / 3) + 4) {
    problem(fields, name, 'too-large');
    return null;
  }
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    problem(fields, name, 'format');
    return null;
  }
  return Buffer.from(value, 'base64');
}

/** An editor uploads a slide image: `{ desktop, mobile? }`, each a base64 picture. */
export async function uploadSlideImage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<SlideImageView, SlideImageFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const fields: Problems = [];
  const body =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (body === null)
    return err({ code: 'validation.failed', fields: [{ path: '', code: 'type' }] });
  for (const key of Object.keys(body)) {
    if (key !== 'desktop' && key !== 'mobile') problem(fields, key, 'unknown');
  }
  const desktopBytes = badBase64(fields, 'desktop', body['desktop']);
  const mobileGiven = body['mobile'] !== undefined && body['mobile'] !== null;
  const mobileBytes = mobileGiven ? badBase64(fields, 'mobile', body['mobile']) : null;
  if (fields.length > 0 || desktopBytes === null || (mobileGiven && mobileBytes === null)) {
    return err({ code: 'validation.failed', fields });
  }

  const { market } = context;
  const desktop = await deps.imageProcessor.process('desktop', desktopBytes);
  if (!desktop.ok) return refusal(desktop.error.code);
  let mobile = null;
  if (mobileBytes !== null) {
    const processed = await deps.imageProcessor.process('mobile', mobileBytes);
    if (!processed.ok) return refusal(processed.error.code);
    mobile = processed.value;
  }

  const imageId = deps.ids.next<'SlideImage'>();
  const renditions: StoredSlideRendition[] = [];
  const stored: string[] = [];
  try {
    for (const rendition of [...desktop.value, ...(mobile ?? [])]) {
      const objectKey = slideImageObjectKey(imageId, rendition.size);
      await deps.objectStore.put(objectKey, rendition.bytes);
      stored.push(objectKey);
      renditions.push({
        size: rendition.size,
        objectKey,
        sha256: createHash('sha256').update(rendition.bytes).digest(),
        byteSize: rendition.bytes.length,
        width: rendition.width,
        height: rendition.height,
      });
    }
  } catch {
    await removeObjects(deps.objectStore, stored);
    return err({ code: 'access.unavailable' });
  }
  const largest = renditions.find((rendition) => rendition.size === 'desktop');
  if (largest === undefined) {
    await removeObjects(deps.objectStore, stored);
    return err({ code: 'file.unreadable' });
  }
  const hasMobile = mobile !== null;
  try {
    await deps.unitOfWork.run<true, never>(market, async () => {
      await deps.slideImages.insert(market, {
        id: imageId,
        uploaderAccountId: admin.accountId,
        hasMobile,
        width: largest.width,
        height: largest.height,
        uploadedBytes: desktopBytes.length + (mobileBytes?.length ?? 0),
        createdAt: deps.clock.now(),
        renditions,
      });
      await deps.audit.record(
        context,
        StorefrontSlideImageUploaded.entry(imageId, { after: { hasMobile } }),
      );
      return ok(true);
    });
  } catch (error) {
    await removeObjects(deps.objectStore, stored);
    logger.error({
      msg: 'storefront.slide-image-upload.failed',
      error: error instanceof Error ? error.name : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
  logger.log({
    msg: 'storefront.slide-image-upload',
    hasMobile,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return ok({ imageId, hasMobile, width: largest.width, height: largest.height });
}

function refusal(code: SlideImageRefusalCode): Result<never, SlideImageFailure> {
  // Too many pictures are in flight: the same 503 as a store fault, with a short wait.
  return code === 'file.busy'
    ? err({ code: 'access.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS })
    : err({ code });
}

/** The bytes of one rendition of a slide image of this Market; anonymous. */
export async function readSlideImage(
  deps: StorefrontDependencies,
  context: CallContext,
  input: { readonly imageId: unknown; readonly size: unknown },
): Promise<Result<SlideImageBytes, SlideImageFailure>> {
  const image = typeof input.imageId === 'string' ? parseId<'SlideImage'>(input.imageId) : null;
  if (image === null || !image.ok) return err({ code: 'storefront.slide-image-not-found' });
  if (typeof input.size !== 'string' || !isSlideImageSize(input.size)) {
    return err({ code: 'storefront.slide-image-not-found' });
  }
  const size = input.size;
  const { market } = context;
  let rendition;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.slideImages.rendition(market, image.value, size)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    rendition = read.value;
  } catch {
    return err({ code: 'access.unavailable' });
  }
  if (rendition === null) return err({ code: 'storefront.slide-image-not-found' });
  try {
    const bytes = await deps.objectStore.get(rendition.objectKey);
    if (bytes === null) return err({ code: 'storefront.slide-image-not-found' });
    if (!createHash('sha256').update(bytes).digest().equals(rendition.sha256)) {
      logger.error({
        msg: 'storefront.slide-image-read.hash-mismatch',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    return ok({ bytes, contentType: 'image/jpeg' });
  } catch {
    return err({ code: 'access.unavailable' });
  }
}
