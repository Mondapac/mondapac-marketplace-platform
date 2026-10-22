// Product photos on the buyer site. The API's reads give photo references (`primaryImage` on a
// card, `images` on the product page): an id and a pixel size, never a URL. The page builds the
// URL here, from the photo origin (`STOREFRONT_IMAGE_ORIGIN`), the Market of the host the buyer
// came to and the validated ids, so a body can never name where the browser loads from. A
// reference that is not the expected shape is dropped on its own: that photo is absent, the
// product and the rest of the page stay.

export type PhotoSize = 'thumb' | 'medium' | 'large';

/** The most photos one product page shows (the API sends at most this many). */
export const MAX_PHOTOS = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MARKET_ID = /^[A-Z]{2}$/u;
const LOCAL_ORIGIN = /^(localhost|127\.0\.0\.1|[a-z0-9-]+\.localhost)$/u;
const MAX_SIDE = 20_000;

/** Builds the browser URL of one photo of a product. */
export type PhotoUrl = (productId: string, imageId: string, size: PhotoSize) => string | undefined;

/**
 * Parses `STOREFRONT_IMAGE_ORIGIN`: `scheme://host[:port]` with no path, https (http only on
 * localhost). Empty or absent is null: no photos are shown, and cards keep their illustration.
 * Throws on anything malformed, so start-up fails rather than shipping broken photo links.
 */
export function parseImageOrigin(raw: string | undefined): string | null {
  const text = raw?.trim() ?? '';
  if (text === '') return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('STOREFRONT_IMAGE_ORIGIN is not an origin');
  }
  if (url.origin !== text || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error('STOREFRONT_IMAGE_ORIGIN must be scheme://host[:port] with no path');
  }
  if (url.protocol === 'http:' && !LOCAL_ORIGIN.test(url.hostname)) {
    throw new Error('STOREFRONT_IMAGE_ORIGIN must use https (http only on localhost)');
  }
  return url.origin;
}

/**
 * The URL builder of a photo origin and Market, or null when photos are off (no origin, or a
 * Market that is not a two-letter code). The builder answers undefined for an id that is not a
 * UUID, so nothing but UUIDs ever reaches a path.
 */
export function photoUrlBuilder(origin: string | null, marketId: string | null): PhotoUrl | null {
  if (origin === null || marketId === null || !MARKET_ID.test(marketId)) return null;
  return (productId, imageId, size) =>
    UUID.test(productId.toLowerCase()) && UUID.test(imageId.toLowerCase())
      ? `${origin}/catalog/public-images/${marketId}/${productId.toLowerCase()}/` +
        `${imageId.toLowerCase()}/${size}`
      : undefined;
}

/** One photo reference checked field by field: its id, or undefined when it is not one. */
export function imageIdOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { imageId, width, height, alt } = value as Record<string, unknown>;
  if (typeof imageId !== 'string' || !UUID.test(imageId.toLowerCase())) return undefined;
  const side = (n: unknown): boolean =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;
  if (!side(width) || !side(height) || typeof alt !== 'string') return undefined;
  return imageId.toLowerCase();
}

/** The photo ids of an `images` list: valid references only, no repeats, at most {@link MAX_PHOTOS}. */
export function imageIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value as unknown[]) {
    const id = imageIdOf(entry);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_PHOTOS) break;
  }
  return ids;
}
