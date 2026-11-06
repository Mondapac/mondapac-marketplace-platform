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

/** A checked photo reference: the id and the pixel size of its largest rendition. */
export interface PhotoRef {
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
}

/** One photo reference checked field by field, or undefined when it is not one. */
export function imageRefOf(value: unknown): PhotoRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { imageId, width, height, alt } = value as Record<string, unknown>;
  if (typeof imageId !== 'string' || !UUID.test(imageId.toLowerCase())) return undefined;
  const side = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;
  if (!side(width) || !side(height) || typeof alt !== 'string') return undefined;
  return { imageId: imageId.toLowerCase(), width, height };
}

/** One photo reference checked field by field: its id, or undefined when it is not one. */
export function imageIdOf(value: unknown): string | undefined {
  return imageRefOf(value)?.imageId;
}

/** The references of an `images` list: valid ones only, no repeats, at most {@link MAX_PHOTOS}. */
export function imageRefsOf(value: unknown): PhotoRef[] {
  if (!Array.isArray(value)) return [];
  const refs: PhotoRef[] = [];
  for (const entry of value as unknown[]) {
    const ref = imageRefOf(entry);
    if (ref !== undefined && !refs.some((r) => r.imageId === ref.imageId)) refs.push(ref);
    if (refs.length === MAX_PHOTOS) break;
  }
  return refs;
}

/** The photo ids of an `images` list: valid references only, no repeats, at most {@link MAX_PHOTOS}. */
export function imageIdsOf(value: unknown): string[] {
  return imageRefsOf(value).map((ref) => ref.imageId);
}

/**
 * The longest side each rendition fits (the API's image processor, `sharp-image-processor.ts`).
 * A rendition never enlarges the original, and the API's `width` and `height` are those of the
 * largest rendition, so every size here is that size scaled to fit its limit.
 */
export const RENDITION_SIDE: Readonly<Record<PhotoSize, number>> = {
  thumb: 240,
  medium: 800,
  large: 1600,
};

/** The pixel size of one rendition of a photo whose largest rendition is `width` by `height`. */
export function renditionSize(
  ref: Pick<PhotoRef, 'width' | 'height'>,
  size: PhotoSize,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, RENDITION_SIDE[size] / Math.max(ref.width, ref.height));
  return {
    width: Math.max(1, Math.round(ref.width * scale)),
    height: Math.max(1, Math.round(ref.height * scale)),
  };
}

/** What an `<img>` needs to reserve its space and pick a rendition. */
export interface PhotoSet {
  /** The URL of the largest rendition: what the image sitemap and the JSON-LD `image` list. */
  readonly largest: string;
  /** `srcset` over the renditions, with their real widths. */
  readonly srcSet: string;
  /** Width and height of the rendition `src` points to, so the box keeps the photo's ratio. */
  readonly width: number;
  readonly height: number;
}

/**
 * The `srcset` of one photo over thumb, medium and large, each with its real pixel width. A photo
 * smaller than a limit gets the same pixels for several sizes: only one entry is kept per width.
 * `width` and `height` are those of the `src` rendition. Undefined when the builder refuses an id.
 */
export function photoSetOf(
  build: PhotoUrl,
  productId: string,
  ref: PhotoRef,
  src: PhotoSize,
): PhotoSet | undefined {
  const byWidth = new Map<number, string>();
  let largest = '';
  for (const size of ['thumb', 'medium', 'large'] as const) {
    const url = build(productId, ref.imageId, size);
    if (url === undefined) return undefined;
    byWidth.set(renditionSize(ref, size).width, url);
    largest = url;
  }
  return {
    largest,
    srcSet: [...byWidth].map(([width, url]) => `${url} ${width}w`).join(', '),
    ...renditionSize(ref, src),
  };
}
