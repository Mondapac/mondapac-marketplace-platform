import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { MediaSize } from '../../domain/media';

export type MediaId = Id<'BlogMedia'>;

/** One stored size of a blog picture. */
export interface StoredMediaRendition {
  readonly size: MediaSize;
  readonly objectKey: string;
  readonly sha256: Buffer;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
}

/** A new picture, its files already written. */
export interface NewMedia {
  readonly id: MediaId;
  readonly uploaderAccountId: Id<'Account'>;
  /** The size of the `large` rendition. */
  readonly width: number;
  readonly height: number;
  /** The size of the upload in bytes (abuse review); the upload is not kept. */
  readonly uploadedBytes: number;
  readonly createdAt: Temporal.Instant;
  readonly renditions: readonly StoredMediaRendition[];
}

/** A picture as the library lists it. */
export interface MediaRecord {
  readonly id: MediaId;
  readonly uploaderAccountId: Id<'Account'>;
  readonly width: number;
  readonly height: number;
  readonly createdAt: Temporal.Instant;
}

/**
 * The blog media library (blog media upload), behind the open unit of the caller and the
 * Market-scoped client. Pictures are inserted once and never changed.
 */
export interface BlogMediaStore {
  insert(market: MarketContext, media: NewMedia): Promise<void>;

  /** Which of these ids are pictures of this Market. */
  existing(market: MarketContext, ids: readonly string[]): Promise<ReadonlySet<string>>;

  /** The pictures of this Market, newest first (then by id, descending). */
  list(
    market: MarketContext,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<readonly MediaRecord[]>;

  /** One stored rendition of a picture of this Market, or null. */
  rendition(
    market: MarketContext,
    mediaId: MediaId,
    size: MediaSize,
  ): Promise<StoredMediaRendition | null>;
}

export const BLOG_MEDIA_STORE = Symbol('BLOG_MEDIA_STORE');
