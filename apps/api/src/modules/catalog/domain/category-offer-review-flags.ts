import type { Id, MarketId, Temporal } from '@mondapac/shared-kernel';

/**
 * A platform category's Offer review flags (risk-based Offer approval slice 4; ADR-0051 decision
 * 4): `always-review` (R7: every first publication of an Offer of a product in it, and every
 * watched edit, waits for an admin) and `review-stop` (R0 for one category: holds first
 * publications and watched edits in every mode). Both are inherited by sub-categories, read side.
 * Admin data, never code; the list ships empty. The row is created by the first change, has its
 * own version and is never deleted.
 */

export const CATEGORY_OFFER_REVIEW_FLAGS = ['always-review', 'review-stop'] as const;
export type CategoryOfferReviewFlag = (typeof CATEGORY_OFFER_REVIEW_FLAGS)[number];

/** One switch: on, and who last changed it and when (both null until first changed). */
export interface FlagSwitch {
  readonly on: boolean;
  readonly changedAt: Temporal.Instant | null;
  readonly changedBy: Id<'Account'> | null;
}

const NEVER_CHANGED: FlagSwitch = Object.freeze({ on: false, changedAt: null, changedBy: null });

export interface CategoryOfferReviewFlagsState {
  readonly marketId: MarketId;
  readonly categoryId: Id<'Category'>;
  readonly alwaysReview: FlagSwitch;
  readonly reviewStop: FlagSwitch;
  /** 0 while the category has no row; the row is created at 1 and raised by one per write. */
  readonly version: number;
  readonly createdAt: Temporal.Instant | null;
}

/** The longest reason a flag change takes (the change log's CHECK). */
export const MAX_FLAG_REASON_CHARS = 500;

/** The reason trimmed, or why it is refused. Never logged, never in an audit row. */
export function flagReasonOf(
  raw: unknown,
): { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly code: string } {
  if (raw === undefined || raw === null) return { ok: false, code: 'required' };
  if (typeof raw !== 'string') return { ok: false, code: 'type' };
  const reason = raw.trim();
  if (reason.length === 0) return { ok: false, code: 'required' };
  if ([...reason].length > MAX_FLAG_REASON_CHARS) return { ok: false, code: 'too-long' };
  return { ok: true, reason };
}

export class CategoryOfferReviewFlags {
  #state: CategoryOfferReviewFlagsState;

  private constructor(state: CategoryOfferReviewFlagsState) {
    this.#state = state;
  }

  /** A category no flag was ever changed for: both off, version 0, no row yet. */
  static none(marketId: MarketId, categoryId: Id<'Category'>): CategoryOfferReviewFlags {
    return new CategoryOfferReviewFlags({
      marketId,
      categoryId,
      alwaysReview: NEVER_CHANGED,
      reviewStop: NEVER_CHANGED,
      version: 0,
      createdAt: null,
    });
  }

  static restore(state: CategoryOfferReviewFlagsState): CategoryOfferReviewFlags {
    return new CategoryOfferReviewFlags(state);
  }

  get state(): CategoryOfferReviewFlagsState {
    return this.#state;
  }

  /** True when the category has no stored row yet (the first change inserts it). */
  get isNew(): boolean {
    return this.#state.version === 0;
  }

  valueOf(flag: CategoryOfferReviewFlag): boolean {
    return (flag === 'always-review' ? this.#state.alwaysReview : this.#state.reviewStop).on;
  }

  /**
   * Switches one flag: the previous value, or null when it already held `on` (nothing to write).
   * The stored version is the repository's business.
   */
  set(input: {
    readonly flag: CategoryOfferReviewFlag;
    readonly on: boolean;
    readonly by: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): { readonly previous: boolean } | null {
    const previous = this.valueOf(input.flag);
    if (previous === input.on) return null;
    const next: FlagSwitch = { on: input.on, changedAt: input.now, changedBy: input.by };
    this.#state =
      input.flag === 'always-review'
        ? { ...this.#state, alwaysReview: next }
        : { ...this.#state, reviewStop: next };
    if (this.#state.createdAt === null) this.#state = { ...this.#state, createdAt: input.now };
    return { previous };
  }
}

/** A category with a flag on, as the facts read lists them (one row per flagged category). */
export interface FlaggedCategory {
  readonly categoryId: string;
  readonly alwaysReview: boolean;
  readonly reviewStop: boolean;
}

/**
 * R7 and the category stop for one product (pure): `categoryIds` are the product's categories and
 * every ancestor of each; a flag on any of them applies (sub-categories inherit).
 */
export function categoryReviewFactsOf(
  categoryIds: Iterable<string>,
  flagged: readonly FlaggedCategory[],
): { readonly sensitiveCategory: boolean; readonly emergencyStop: boolean } {
  const ids = new Set(categoryIds);
  let sensitiveCategory = false;
  let emergencyStop = false;
  for (const row of flagged) {
    if (!ids.has(row.categoryId)) continue;
    sensitiveCategory ||= row.alwaysReview;
    emergencyStop ||= row.reviewStop;
  }
  return { sensitiveCategory, emergencyStop };
}
