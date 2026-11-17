import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { IMAGE_BUSY_RETRY_SECONDS } from '../../../platform/images/image-pipeline';
import { BlogMediaUploaded } from '../domain/audit';
import { closedObject, problem } from '../domain/fields';
import type { Problems } from '../domain/fields';
import { isMediaSize, MAX_MEDIA_UPLOAD_BYTES, mediaObjectKey } from '../domain/media';
import type { MediaSize } from '../domain/media';
import type { BlogDependencies } from './blog-dependencies';
import type { BlogFailure } from './failures';
import { adminOf, fieldsOf } from './post-support';
import type { MediaRefusalCode } from './ports/blog-image-processor';
import type { MediaId, MediaRecord, StoredMediaRendition } from './ports/blog-media.store';

// The blog media library (blog media upload): an admin uploads a picture once (base64 in a JSON
// body); it is decoded and written again as metadata-free JPEG renditions (`large`, `thumb`), the
// raw upload is never stored, the files go to the object store under keys built by the server and
// one row records them, audited in the same unit. A post's cover or image block then names it by
// id. Admins read the library newest first and a rendition by id. Nothing here is public.

const logger = new Logger('BlogMedia');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export const MEDIA_PAGE_SIZE = 40;

export interface MediaView {
  readonly id: MediaId;
  readonly width: number;
  readonly height: number;
  readonly createdAt: Temporal.Instant;
  /** The uploader's account id: an admin's view only. */
  readonly uploadedBy: Id<'Account'>;
}

export interface MediaPage {
  readonly items: readonly MediaView[];
  readonly page: number;
  readonly pageSize: number;
  readonly hasMore: boolean;
}

export interface MediaBytes {
  readonly bytes: Buffer;
  /** Always `image/jpeg`: every rendition is written by the server. */
  readonly contentType: 'image/jpeg';
}

const viewOf = (record: MediaRecord): MediaView => ({
  id: record.id,
  width: record.width,
  height: record.height,
  createdAt: record.createdAt,
  uploadedBy: record.uploaderAccountId,
});

/**
 * The base64 text of an upload: present, at most {@link MAX_MEDIA_UPLOAD_BYTES} once decoded, and
 * standard base64. Nothing is decoded before these checks.
 */
function uploadBytes(
  problems: Problems,
  value: unknown,
): { readonly bytes: Buffer } | { readonly tooLarge: true } | null {
  if (value === undefined || value === null) {
    problem(problems, 'data', 'required');
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    problem(problems, 'data', typeof value === 'string' ? 'required' : 'type');
    return null;
  }
  if (value.length > Math.ceil((MAX_MEDIA_UPLOAD_BYTES * 4) / 3) + 4) return { tooLarge: true };
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    problem(problems, 'data', 'format');
    return null;
  }
  return { bytes: Buffer.from(value, 'base64') };
}

function refusalOf(code: MediaRefusalCode): BlogFailure {
  // Too many pictures are in flight: the same 503 as a store fault, with a short wait.
  return code === 'file.busy'
    ? { code: 'blog.unavailable', retryAfterSeconds: IMAGE_BUSY_RETRY_SECONDS }
    : { code };
}

async function removeObjects(deps: BlogDependencies, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => deps.objectStore.delete(key).catch(() => undefined)));
}

/** An admin uploads a picture: body `{ data }`, a base64 JPEG, PNG or WebP of at most 4 MiB. */
export async function uploadMedia(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly body: unknown },
): Promise<Result<MediaView, BlogFailure>> {
  const admin = adminOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const problems: Problems = [];
  const body = input?.body;
  if (!closedObject(problems, '', body, ['data']) || problems.length > 0) {
    return err(fieldsOf(problems));
  }
  const upload = uploadBytes(problems, body.data);
  if (upload === null) return err(fieldsOf(problems));
  if ('tooLarge' in upload) return err({ code: 'file.too-large' });

  const { market } = context;
  const processed = await deps.imageProcessor.process(upload.bytes);
  if (!processed.ok) return err(refusalOf(processed.error.code));

  const mediaId = deps.ids.next<'BlogMedia'>();
  const renditions: StoredMediaRendition[] = [];
  const stored: string[] = [];
  try {
    for (const rendition of processed.value) {
      const objectKey = mediaObjectKey(mediaId, rendition.size);
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
    await removeObjects(deps, stored);
    return err({ code: 'blog.unavailable' });
  }
  const large = renditions.find((rendition) => rendition.size === 'large');
  if (large === undefined || !renditions.some((rendition) => rendition.size === 'thumb')) {
    await removeObjects(deps, stored);
    return err({ code: 'file.unreadable' });
  }
  const createdAt = deps.clock.now();
  try {
    await deps.unitOfWork.run<true, never>(market, async () => {
      await deps.media.insert(market, {
        id: mediaId,
        uploaderAccountId: admin.accountId,
        width: large.width,
        height: large.height,
        uploadedBytes: upload.bytes.length,
        createdAt,
        renditions,
      });
      await deps.audit.record(
        context,
        BlogMediaUploaded.entry(mediaId, { after: { width: large.width, height: large.height } }),
      );
      return ok(true);
    });
  } catch (error) {
    await removeObjects(deps, stored);
    logger.error({
      msg: 'blog.media-upload.failed',
      error: error instanceof Error ? error.name : 'unknown',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'blog.unavailable' });
  }
  return ok({
    id: mediaId,
    width: large.width,
    height: large.height,
    createdAt,
    uploadedBy: admin.accountId,
  });
}

function pageOf(problems: Problems, value: unknown): number {
  if (value === undefined) return 1;
  const parsed = typeof value === 'string' && /^\d{1,4}$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    problem(problems, 'page', 'value');
    return 1;
  }
  return parsed;
}

/** The pictures of the Market's library, newest first, {@link MEDIA_PAGE_SIZE} a page. */
export async function listMedia(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly query?: unknown },
): Promise<Result<MediaPage, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const problems: Problems = [];
  const query = input?.query ?? {};
  if (!closedObject(problems, '', query, ['page'])) return err(fieldsOf(problems));
  const page = pageOf(problems, query.page);
  if (problems.length > 0) return err(fieldsOf(problems));
  const { market } = context;
  return deps.unitOfWork.run<MediaPage, BlogFailure>(
    market,
    async () => {
      const rows = await deps.media.list(market, {
        limit: MEDIA_PAGE_SIZE + 1,
        offset: (page - 1) * MEDIA_PAGE_SIZE,
      });
      return ok({
        items: rows.slice(0, MEDIA_PAGE_SIZE).map(viewOf),
        page,
        pageSize: MEDIA_PAGE_SIZE,
        hasMore: rows.length > MEDIA_PAGE_SIZE,
      });
    },
    { readOnly: true },
  );
}

/**
 * The bytes of one rendition of a picture of the Market. The key is read from the stored row,
 * never built from the request; a malformed id, an unknown size and a picture of another Market
 * answer one `blog.media-not-found`. The bytes must match the stored hash.
 */
export async function readMedia(
  deps: BlogDependencies,
  context: CallContext,
  input: { readonly media: unknown; readonly size: unknown },
): Promise<Result<MediaBytes, BlogFailure>> {
  if (adminOf(context) === null) return err({ code: 'access.denied' });
  const parsed = typeof input?.media === 'string' ? parseId<'BlogMedia'>(input.media) : null;
  if (parsed === null || !parsed.ok) return err({ code: 'blog.media-not-found' });
  if (typeof input.size !== 'string' || !isMediaSize(input.size)) {
    return err({ code: 'blog.media-not-found' });
  }
  const size: MediaSize = input.size;
  const { market } = context;
  let rendition: StoredMediaRendition | null;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.media.rendition(market, parsed.value, size)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'blog.unavailable' });
    rendition = read.value;
  } catch {
    return err({ code: 'blog.unavailable' });
  }
  if (rendition === null) return err({ code: 'blog.media-not-found' });
  try {
    const bytes = await deps.objectStore.get(rendition.objectKey);
    if (bytes === null) return err({ code: 'blog.media-not-found' });
    if (!createHash('sha256').update(bytes).digest().equals(rendition.sha256)) {
      logger.error({
        msg: 'blog.media-read.hash-mismatch',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'blog.unavailable' });
    }
    return ok({ bytes, contentType: 'image/jpeg' });
  } catch {
    return err({ code: 'blog.unavailable' });
  }
}
