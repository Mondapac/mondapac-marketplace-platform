import type { PostContent } from './content';

// The blog media library (blog media upload): an admin uploads a picture once, and a post's cover
// (`coverImageId`) or an image block (`imageId`) names it by id. A name must be a picture of the
// library of the post's own Market.

/** The stored sizes of a blog picture: `large` for the article, `thumb` for lists and pickers. */
export const MEDIA_SIZES = ['large', 'thumb'] as const;
export type MediaSize = (typeof MEDIA_SIZES)[number];

export function isMediaSize(value: string): value is MediaSize {
  return (MEDIA_SIZES as readonly string[]).includes(value);
}

/** The largest accepted upload in bytes (the editor shrinks a picture in the browser first). */
export const MAX_MEDIA_UPLOAD_BYTES = 4 * 1024 * 1024;

/** The longest side of an upload must be at least this, in pixels (after orientation). */
export const MIN_MEDIA_LONGEST_SIDE = 400;

/**
 * The object key of one rendition: built by code from the id and a closed size, never from a
 * request (a CHECK of `blog.media_renditions` says the same). Distinct from every other module's
 * keys (catalog's photos start with a product id, the slides with `slide-images/`).
 */
export function mediaObjectKey(mediaId: string, size: MediaSize): string {
  return `blog-media/${mediaId}/${size}`;
}

/** One picture a content names, with the path of the field that names it. */
export interface MediaRef {
  readonly path: string;
  readonly id: string;
}

/** Every picture a content names: the cover first, then the image blocks in body order. */
export function mediaRefsOf(content: PostContent): readonly MediaRef[] {
  const refs: MediaRef[] = [];
  if (content.coverImageId !== null) refs.push({ path: 'coverImageId', id: content.coverImageId });
  for (const [index, block] of content.body.entries()) {
    if (block.type === 'image') refs.push({ path: `body[${index}].imageId`, id: block.imageId });
  }
  return refs;
}

/** The distinct ids of {@link mediaRefsOf}. */
export const mediaIdsOf = (content: PostContent): readonly string[] => [
  ...new Set(mediaRefsOf(content).map((ref) => ref.id)),
];
