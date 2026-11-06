import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

export type RenditionSize = 'thumb' | 'medium' | 'large';

export const RENDITION_SIZES: readonly RenditionSize[] = ['thumb', 'medium', 'large'];

export function isRenditionSize(value: string): value is RenditionSize {
  return (RENDITION_SIZES as readonly string[]).includes(value);
}

/** The formats a photo is kept in: JPEG always, WebP and AVIF besides (SEO 6B-2). */
export type RenditionFormat = 'jpeg' | 'webp' | 'avif';

export const RENDITION_FORMATS: readonly RenditionFormat[] = ['jpeg', 'webp', 'avif'];

/** The route's `size` segment: `large` (JPEG), `large.webp` or `large.avif`. Null for anything else. */
export function parseRenditionName(
  value: string,
): { readonly size: RenditionSize; readonly format: RenditionFormat } | null {
  const [size, extension, ...rest] = value.split('.');
  if (size === undefined || !isRenditionSize(size) || rest.length > 0) return null;
  if (extension === undefined) return { size, format: 'jpeg' };
  return extension === 'webp' || extension === 'avif' ? { size, format: extension } : null;
}

/** The object key of a rendition: the JPEG keeps the key it always had. */
export function renditionObjectKey(
  productId: string,
  imageId: string,
  size: RenditionSize,
  format: RenditionFormat,
): string {
  const base = `${productId}/${imageId}/${size}`;
  // An object key has no dot (`isValidObjectKey`), so the format is joined with a dash.
  return format === 'jpeg' ? base : `${base}-${format}`;
}

export interface StoredRendition {
  readonly size: RenditionSize;
  readonly format: RenditionFormat;
  readonly objectKey: string;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

export interface ProductImage {
  readonly id: Id<'ProductImage'>;
  readonly productId: Id<'Product'>;
  readonly uploaderAccountId: Id<'Account'>;
  readonly state: 'clean' | 'taken-down';
  readonly width: number;
  readonly height: number;
  readonly uploadedBytes: number;
  readonly createdAt: Temporal.Instant;
  readonly renditions: readonly StoredRendition[];
}

/** One photo of a revision: its place (1 is the primary photo) and what it is now. */
export interface RevisionImage {
  readonly imageId: Id<'ProductImage'>;
  readonly position: number;
  readonly state: ProductImage['state'];
  readonly width: number;
  readonly height: number;
}

/** A clean photo that lacks some formats, with its JPEG renditions to derive them from. */
export interface ImageMissingFormats {
  readonly id: Id<'ProductImage'>;
  readonly productId: Id<'Product'>;
  readonly jpegs: readonly { readonly size: RenditionSize; readonly objectKey: string }[];
  readonly missing: readonly {
    readonly size: RenditionSize;
    readonly format: Exclude<RenditionFormat, 'jpeg'>;
  }[];
}

/** A clean photo no revision holds, with the keys of its files (the orphan sweep). */
export interface UnattachedImage {
  readonly id: Id<'ProductImage'>;
  readonly productId: Id<'Product'>;
  readonly objectKeys: readonly string[];
}

export interface TakedownMark {
  readonly at: Temporal.Instant;
  readonly byAccountId: Id<'Account'>;
  readonly reasonCode: string;
}

/** Photos of products (catalog design 10, simplified path). Every read names the product. */
export interface ProductImageRepository {
  add(market: MarketContext, image: ProductImage): Promise<void>;
  /** The product's images, oldest first. */
  list(market: MarketContext, productId: Id<'Product'>): Promise<readonly ProductImage[]>;
  find(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<ProductImage | null>;
  /** Which of these ids are clean images of this product. */
  cleanIdsOf(
    market: MarketContext,
    productId: Id<'Product'>,
    ids: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /** The photos of one revision in order, with their current state (also taken-down ones). */
  listForRevision(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
  ): Promise<readonly RevisionImage[]>;
  /**
   * Moves a clean photo to taken-down. True when this call did it; false when the photo does not
   * exist or is not clean (already taken down). Forward-only (the database refuses the rest).
   */
  takeDown(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
    mark: TakedownMark,
  ): Promise<boolean>;
  /**
   * Of the given object keys, those that belong to a product of this Market and that no photo row
   * names: files a crash left behind (the file write happens before the row). A key whose product
   * is not in this Market is never returned, so one Market's sweep cannot take another's files.
   */
  unreferencedObjectKeys(
    market: MarketContext,
    keys: readonly string[],
  ): Promise<readonly string[]>;
  /**
   * Clean photos created before the instant that no revision holds, ordered by id, after the
   * given id. Whether a draft still names one is for the caller to check.
   */
  listUnattached(
    market: MarketContext,
    query: {
      readonly createdBefore: Temporal.Instant;
      readonly afterId: string | null;
      readonly limit: number;
    },
  ): Promise<readonly UnattachedImage[]>;
  /**
   * Clean photos, ordered by id after the given id, that lack the WebP or the AVIF of any size.
   */
  listMissingFormats(
    market: MarketContext,
    query: { readonly afterId: string | null; readonly limit: number },
  ): Promise<readonly ImageMissingFormats[]>;
  /**
   * Adds rendition rows to an existing clean photo. Insert-only; a row that already exists is
   * left as it is (a second run of the reprocess adds nothing). False, with nothing added, when
   * the photo is not clean any more (taken down since it was listed).
   */
  addRenditions(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
    renditions: readonly StoredRendition[],
  ): Promise<boolean>;
  /**
   * True when deleted; false when a revision uses it (also when one joined after the check: the
   * foreign key refuses), it is taken down (the takedown record stays) or it does not exist.
   */
  deleteUnused(
    market: MarketContext,
    productId: Id<'Product'>,
    imageId: Id<'ProductImage'>,
  ): Promise<boolean>;
}

export const PRODUCT_IMAGE_REPOSITORY = Symbol('PRODUCT_IMAGE_REPOSITORY');
