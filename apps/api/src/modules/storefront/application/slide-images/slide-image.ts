import type { Id } from '@mondapac/shared-kernel';

/** The stored sizes of a slide image: wide pictures for desktop, tall ones for mobile. */
export const SLIDE_IMAGE_SIZES = ['desktop', 'desktop-small', 'mobile', 'mobile-small'] as const;
export type SlideImageSize = (typeof SLIDE_IMAGE_SIZES)[number];

export function isSlideImageSize(value: string): value is SlideImageSize {
  return (SLIDE_IMAGE_SIZES as readonly string[]).includes(value);
}

/** The largest accepted upload in bytes (one picture). */
export const MAX_SLIDE_UPLOAD_BYTES = 4 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The library image a slide's `image.ref` names, or null when the ref is a ready-made image key of
 * the buyer app (those are never UUIDs).
 */
export function libraryImageOf(ref: string): Id<'SlideImage'> | null {
  return UUID.test(ref) ? (ref as Id<'SlideImage'>) : null;
}

/**
 * The object key of one rendition: built by code from the id and a closed size, never from a
 * request (a CHECK of `slide_image_renditions` says the same).
 */
export function slideImageObjectKey(imageId: Id<'SlideImage'>, size: SlideImageSize): string {
  return `slide-images/${imageId}/${size}`;
}

/** The public path of a rendition, built by code. */
export function slideImagePath(imageId: string, size: SlideImageSize): string {
  return `/storefront/slide-images/${imageId}/${size}`;
}

/** Deletes objects one by one; a failure leaves an unreachable object, never an error to the caller. */
export async function removeObjects(
  store: { delete(key: string): Promise<void> },
  keys: readonly string[],
): Promise<void> {
  await Promise.all(keys.map((key) => store.delete(key).catch(() => undefined)));
}
