import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ServedPlacement } from '../../domain/slide-public';
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

/** A version without its JSON columns: what a version list needs. */
export type SlideVersionSummary = Pick<
  SlideVersionRecord,
  'id' | 'slideId' | 'versionNo' | 'internalName' | 'createdAt' | 'approvedAt'
>;

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

/** A placement of an approved slide that is not over yet, as the reorder reads it. */
export interface LivePlacement {
  readonly slideId: Id<'StorefrontSlide'>;
  readonly sortOrder: number;
  readonly startsAt: Temporal.Instant;
}

/** The place of one slide in the order of one position and scope. */
export interface PlacementOrder {
  readonly position: string;
  readonly scope: string;
  readonly scopeId: string | null;
}

/** The saved order of one placement of a slide: it outlives the projection rows. */
export interface SavedOrder extends PlacementOrder {
  readonly sortOrder: number;
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
  /**
   * Like `findSlide`, and takes the slide row's write lock for the rest of the unit (it raises the
   * row's version, and writes no other column).
   */
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
  /** Newest first, at most `limit`; the content and placements are not read. */
  versions(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    limit: number,
  ): Promise<readonly SlideVersionSummary[]>;
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
  /**
   * The projected placements of a position whose window ends after `after`, of slides that are
   * approved now (not paused, not archived), at most `limit`, soonest start first. A slide of
   * another Market is never found.
   */
  servedAt(
    market: MarketContext,
    position: string,
    after: Temporal.Instant,
    limit: number,
  ): Promise<readonly ServedPlacement[]>;
  /** The projection of one slide. */
  placementsOf(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
  ): Promise<readonly PlacementRow[]>;
  /**
   * The projected placements at one position and scope (`scopeId` null for `all`) of slides that
   * are approved now and whose window ends after `after`: the slides a reorder must name. Best
   * first: sort order, then start, then slide id.
   */
  livePlacementsAt(
    market: MarketContext,
    where: PlacementOrder,
    after: Temporal.Instant,
  ): Promise<readonly LivePlacement[]>;
  /**
   * Gives the placement of each slide at `where` the sort order named, and saves that order for
   * the slide (see `savedOrdersOf`). Writes nothing else.
   */
  setLiveOrder(
    market: MarketContext,
    where: PlacementOrder,
    orders: readonly { readonly slideId: Id<'StorefrontSlide'>; readonly sortOrder: number }[],
    stamp: SlideStamp,
  ): Promise<void>;
  /** The orders saved for a slide by earlier reorders (also while it is paused). */
  savedOrdersOf(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
  ): Promise<readonly SavedOrder[]>;
  /** Forgets the slide's saved orders except those of these placements (a changed or removed one). */
  keepSavedOrders(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    keep: readonly PlacementOrder[],
  ): Promise<void>;
  /** Replaces the slide's projection with these rows (none: removes it). */
  replacePlacements(
    market: MarketContext,
    slideId: Id<'StorefrontSlide'>,
    rows: readonly PlacementRow[],
  ): Promise<void>;
}

export const SLIDE_REPOSITORY = Symbol('STOREFRONT_SLIDE_REPOSITORY');
