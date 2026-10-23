import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PlacedSlide, SlideKind, StoredSlideState } from '../../domain/slides';

export interface SlideRecord {
  readonly id: Id<'StorefrontSlide'>;
  readonly kind: SlideKind;
  readonly internalName: string;
  readonly state: StoredSlideState;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly liveVersionId: Id<'StorefrontSlideVersion'> | null;
  readonly draftVersionId: Id<'StorefrontSlideVersion'> | null;
  readonly submittedVersionId: Id<'StorefrontSlideVersion'> | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

export interface SlideVersionRecord {
  readonly id: Id<'StorefrontSlideVersion'>;
  readonly slideId: Id<'StorefrontSlide'>;
  readonly versionNo: number;
  readonly internalName: string;
  /** The stored JSON; read back only through `readContent`. */
  readonly content: unknown;
  /** The stored JSON; read back only through `readPlacements`. */
  readonly placements: unknown;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly pinned: boolean;
  readonly sponsored: boolean;
  readonly createdAt: Temporal.Instant;
  readonly createdBy: Id<'Account'>;
  readonly approvedBy: Id<'Account'> | null;
  readonly approvedAt: Temporal.Instant | null;
}

export interface SlideStamp {
  readonly at: Temporal.Instant;
  readonly by: Id<'Account'>;
}

/** One row of the live projection. */
export interface PlacementRow {
  readonly id: Id<'StorefrontSlidePlacement'>;
  readonly slideId: Id<'StorefrontSlide'>;
  readonly position: string;
  readonly scope: string;
  readonly scopeId: string | null;
  readonly includeSubcategories: boolean;
  readonly sortOrder: number;
  readonly autoplay: boolean;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
}

export type SlideChange = Partial<
  Pick<
    SlideRecord,
    | 'internalName'
    | 'state'
    | 'startsAt'
    | 'endsAt'
    | 'pinned'
    | 'sponsored'
    | 'liveVersionId'
    | 'draftVersionId'
    | 'submittedVersionId'
  >
>;

/**
 * The slide library of one Market (`storefront.slides`, `slide_versions`, `slide_placements`).
 * Every method runs inside the caller's unit of work and is scoped by the Market: a slide of
 * another Market is never found. Versions are insert-only.
 */
export interface SlideRepository {
  /** Newest first, at most `limit`. */
  listSlides(market: MarketContext, limit: number): Promise<readonly SlideRecord[]>;
  findSlide(market: MarketContext, id: Id<'StorefrontSlide'>): Promise<SlideRecord | null>;
  /** Like `findSlide`, and takes the slide row's write lock for the rest of the unit. */
  lockSlide(market: MarketContext, id: Id<'StorefrontSlide'>): Promise<SlideRecord | null>;
  insertSlide(market: MarketContext, slide: SlideRecord, by: Id<'Account'>): Promise<void>;
  updateSlide(
    market: MarketContext,
    id: Id<'StorefrontSlide'>,
    change: SlideChange,
    stamp: SlideStamp,
  ): Promise<void>;

  /** The versions with these ids (the current draft and live versions of a list). */
  versionsByIds(
    market: MarketContext,
    ids: readonly Id<'StorefrontSlideVersion'>[],
  ): Promise<readonly SlideVersionRecord[]>;
  /** Newest first, at most `limit`. */
  versions(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    limit: number,
  ): Promise<readonly SlideVersionRecord[]>;
  findVersion(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    id: Id<'StorefrontSlideVersion'>,
  ): Promise<SlideVersionRecord | null>;
  lastVersionNo(market: MarketContext, slideId: Id<'StorefrontSlide'>): Promise<number>;
  /** Inserts a version; a version is never changed afterwards except by `markApproved`. */
  insertVersion(
    market: MarketContext,
    version: Omit<SlideVersionRecord, 'approvedBy' | 'approvedAt'>,
  ): Promise<void>;

  /** Stamps the approver on a version that has none. */
  markApproved(
    market: MarketContext,
    id: Id<'StorefrontSlideVersion'>,
    stamp: SlideStamp,
  ): Promise<void>;

  /** Locks the Market's rows for these position keys (created on first use), in key order. */
  lockPositions(
    market: MarketContext,
    keys: readonly string[],
    at: Temporal.Instant,
  ): Promise<void>;
  /** The projected placements of a position whose window meets [from, to). */
  placedAt(
    market: MarketContext,
    position: string,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<readonly (PlacedSlide & { readonly slideId: string })[]>;
  /** The projection of one slide. */
  placementsOf(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
  ): Promise<readonly PlacementRow[]>;
  /** Replaces the slide's projection with these rows (none: removes it). */
  replacePlacements(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    rows: readonly PlacementRow[],
  ): Promise<void>;
}

export const SLIDE_REPOSITORY = Symbol('STOREFRONT_SLIDE_REPOSITORY');
