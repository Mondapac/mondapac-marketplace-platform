import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result } from '@mondapac/shared-kernel';
import { OFFER_CHANGE_REASONS, type OfferChangeReason } from './events';
import { MAX_DECISION_NOTE_CHARS } from './offer-pending-change';

/**
 * Why a published Offer is on the post-publication review list (risk-based Offer approval slice 6;
 * ADR-0051): the keyed sample at its first publication, or what pricing's R4 check of its first
 * price found (no reference, a reference that could not be read, or a re-check outside the band).
 * Codes only: no price or median is ever stored or answered by catalog.
 */
export const OFFER_POST_REVIEW_REASONS = [
  'sample',
  'price-no-reference',
  'price-reference-unavailable',
  'price-recheck-outside',
] as const;
export type OfferPostReviewReason = (typeof OFFER_POST_REVIEW_REASONS)[number];

/** The reasons pricing refers through the catalog facade (everything but the sample). */
export const PRICE_POST_REVIEW_REASONS = [
  'price-no-reference',
  'price-reference-unavailable',
  'price-recheck-outside',
] as const;
export type PricePostReviewReferral = (typeof PRICE_POST_REVIEW_REASONS)[number];

export const OFFER_POST_REVIEW_STATUSES = ['open', 'approved', 'taken-down'] as const;
export type OfferPostReviewStatus = (typeof OFFER_POST_REVIEW_STATUSES)[number];

/** The sample buckets: a draw is one of 10,000, so the percent has two decimals of resolution. */
export const SAMPLE_BUCKETS = 10_000;
/** How long after a seller became Trusted its sampling percent is doubled (design 6). */
export const SAMPLE_DOUBLING_HOURS = 30 * 24;
/** The safe sampling percent: every Offer published at once is checked (fail closed). */
export const SAFE_SAMPLING_PERCENT = 100;

/** The Market's percent as a whole number from 0 to 100; anything else is the safe 100. */
export function samplingPercentOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
    ? value
    : SAFE_SAMPLING_PERCENT;
}

/**
 * The bucket of a draw: the first four bytes of the keyed HMAC, big-endian, scaled to 0..9999
 * (floor(u32 * 10000 / 2^32)). Throws on fewer than four bytes.
 */
export function sampleBucketOf(digest: Uint8Array): number {
  if (digest.length < 4) throw new RangeError('sample: the digest has fewer than four bytes');
  const u32 =
    ((digest[0] as number) * 0x1000000 +
      ((digest[1] as number) << 16) +
      ((digest[2] as number) << 8) +
      (digest[3] as number)) >>>
    0;
  return Math.floor((u32 * SAMPLE_BUCKETS) / 0x100000000);
}

/** Sampled when the bucket is under percent * 100: 0% never samples, 100% always. */
export function isSampled(bucket: number, percent: number): boolean {
  if (!Number.isInteger(bucket) || bucket < 0 || bucket >= SAMPLE_BUCKETS) {
    throw new RangeError('sample: the bucket is out of range');
  }
  return bucket < samplingPercentOf(percent) * 100;
}

/**
 * The effective percent of one draw (design 6): the Market's percent, doubled (at most 100) while
 * the seller became Trusted less than 30 days ago. `trustedSince` null is not doubled. A
 * `trustedSince` after `now` (clock skew) counts as within the 30 days.
 */
export function effectiveSamplingPercent(input: {
  readonly percent: number;
  readonly trustedSince: Temporal.Instant | null;
  readonly now: Temporal.Instant;
}): { readonly percent: number; readonly doubled: boolean } {
  const percent = samplingPercentOf(input.percent);
  if (input.trustedSince === null || percent === 0 || percent === 100) {
    return { percent, doubled: false };
  }
  const end = input.trustedSince.add({ hours: SAMPLE_DOUBLING_HOURS });
  if (Temporal.Instant.compare(input.now, end) >= 0) return { percent, doubled: false };
  return { percent: Math.min(100, percent * 2), doubled: true };
}

export interface OfferPostReviewState {
  readonly id: Id<'OfferPostReview'>;
  readonly marketId: MarketId;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly status: OfferPostReviewStatus;
  /** Never empty; each reason once, in the order received. */
  readonly reasons: readonly OfferPostReviewReason[];
  /** The effective sampling percent (after doubling); set with `sample` only. */
  readonly samplePercent: number | null;
  readonly sampleDoubled: boolean;
  readonly openedAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly decidedAt: Temporal.Instant | null;
  readonly decidedByAccountId: Id<'Account'> | null;
  /** The Offer change reason of a take-down. */
  readonly decisionReasonCode: OfferChangeReason | null;
  /** Take-down only: the seller lost Trusted. */
  readonly misconduct: boolean | null;
  /** The admin's note (required on take-down, optional on approve). Never logged or audited. */
  readonly note: string | null;
  readonly version: number;
}

export type OfferPostReviewRefusal =
  | { readonly code: 'post-review.not-open' }
  | { readonly code: 'post-review.invalid' }
  | { readonly code: 'post-review.note-invalid' };

/** A sample's figures, set once with the `sample` reason. */
export interface SampleFigures {
  readonly percent: number;
  readonly doubled: boolean;
}

function validNote(note: unknown): note is string {
  return (
    typeof note === 'string' && note.trim().length > 0 && note.length <= MAX_DECISION_NOTE_CHARS
  );
}

const isReason = (value: unknown): value is OfferPostReviewReason =>
  (OFFER_POST_REVIEW_REASONS as readonly unknown[]).includes(value);

/**
 * One row of the post-publication review list (slice 6): a published Offer an admin checks after
 * it went live, while it sells. Born `open` with its first reason; while open it only gains
 * reasons (each once); decided once into `approved` or `taken-down`. One open row per Offer (the
 * partial unique); a reason for an Offer whose row is decided opens a new row. Every change raises
 * the version by one (the guard trigger allows nothing else).
 */
export class OfferPostReview {
  #state: OfferPostReviewState;
  readonly #isNew: boolean;
  readonly #loadedVersion: number;
  #changed = false;

  private constructor(state: OfferPostReviewState, isNew: boolean) {
    this.#state = Object.freeze(state);
    this.#isNew = isNew;
    this.#loadedVersion = state.version;
  }

  /** A new open row with its first reason (and the sample's figures with `sample`). */
  static open(input: {
    readonly id: Id<'OfferPostReview'>;
    readonly marketId: MarketId;
    readonly offerId: Id<'Offer'>;
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly reason: OfferPostReviewReason;
    readonly sample?: SampleFigures | null;
    readonly now: Temporal.Instant;
  }): Result<OfferPostReview, OfferPostReviewRefusal> {
    if (!isReason(input.reason)) return err({ code: 'post-review.invalid' });
    const sample = sampleOf(input.reason, input.sample ?? null);
    if (sample === undefined) return err({ code: 'post-review.invalid' });
    return ok(
      new OfferPostReview(
        {
          id: input.id,
          marketId: input.marketId,
          offerId: input.offerId,
          sellerId: input.sellerId,
          productId: input.productId,
          status: 'open',
          reasons: Object.freeze([input.reason]),
          samplePercent: sample?.percent ?? null,
          sampleDoubled: sample?.doubled ?? false,
          openedAt: input.now,
          updatedAt: input.now,
          decidedAt: null,
          decidedByAccountId: null,
          decisionReasonCode: null,
          misconduct: null,
          note: null,
          version: 1,
        },
        true,
      ),
    );
  }

  static restore(state: OfferPostReviewState): OfferPostReview {
    return new OfferPostReview(state, false);
  }

  /**
   * Adds a reason to the open row; false (nothing changed) when it is already there. Refused on a
   * decided row: the caller opens a new one.
   */
  addReason(input: {
    readonly reason: OfferPostReviewReason;
    readonly sample?: SampleFigures | null;
    readonly now: Temporal.Instant;
  }): Result<boolean, OfferPostReviewRefusal> {
    const state = this.#state;
    if (state.status !== 'open') return err({ code: 'post-review.not-open' });
    if (!isReason(input.reason)) return err({ code: 'post-review.invalid' });
    if (state.reasons.includes(input.reason)) return ok(false);
    const sample = sampleOf(input.reason, input.sample ?? null);
    if (sample === undefined) return err({ code: 'post-review.invalid' });
    this.#apply({
      reasons: Object.freeze([...state.reasons, input.reason]),
      ...(sample === null ? {} : { samplePercent: sample.percent, sampleDoubled: sample.doubled }),
      updatedAt: later(input.now, state.updatedAt),
    });
    return ok(true);
  }

  /** An admin closes the row: the Offer stays as it is. The note is optional. */
  approve(input: {
    readonly accountId: Id<'Account'>;
    readonly note?: string | null;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPostReviewRefusal> {
    if (this.#state.status !== 'open') return err({ code: 'post-review.not-open' });
    const note = input.note ?? null;
    if (note !== null && !validNote(note)) return err({ code: 'post-review.note-invalid' });
    this.#decide('approved', input.accountId, null, null, note, input.now);
    return ok(undefined);
  }

  /** An admin takes the Offer down (the use case moves the Offer in the same unit). */
  takeDown(input: {
    readonly accountId: Id<'Account'>;
    readonly reasonCode: OfferChangeReason;
    readonly misconduct: boolean;
    readonly note: string;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPostReviewRefusal> {
    if (this.#state.status !== 'open') return err({ code: 'post-review.not-open' });
    if (!(OFFER_CHANGE_REASONS as readonly string[]).includes(input.reasonCode)) {
      return err({ code: 'post-review.invalid' });
    }
    if (typeof input.misconduct !== 'boolean') return err({ code: 'post-review.invalid' });
    if (!validNote(input.note)) return err({ code: 'post-review.note-invalid' });
    this.#decide(
      'taken-down',
      input.accountId,
      input.reasonCode,
      input.misconduct,
      input.note,
      input.now,
    );
    return ok(undefined);
  }

  #decide(
    status: Exclude<OfferPostReviewStatus, 'open'>,
    accountId: Id<'Account'>,
    reasonCode: OfferChangeReason | null,
    misconduct: boolean | null,
    note: string | null,
    now: Temporal.Instant,
  ): void {
    const at = later(now, this.#state.updatedAt);
    this.#apply({
      status,
      decidedAt: at,
      decidedByAccountId: accountId,
      decisionReasonCode: reasonCode,
      misconduct,
      note,
      updatedAt: at,
    });
  }

  #apply(patch: Partial<OfferPostReviewState>): void {
    this.#state = Object.freeze({
      ...this.#state,
      ...patch,
      version: this.#loadedVersion + 1,
    });
    this.#changed = true;
  }

  get state(): OfferPostReviewState {
    return this.#state;
  }

  /** The version the row was read (or born) at: the repository's conditional update matches it. */
  get loadedVersion(): number {
    return this.#loadedVersion;
  }

  get isNew(): boolean {
    return this.#isNew;
  }

  /** True when something changed since the read (one UPDATE stores it). */
  get changed(): boolean {
    return this.#changed;
  }
}

/** The sample's figures for a reason: null for a price reason, undefined when they do not fit. */
function sampleOf(
  reason: OfferPostReviewReason,
  sample: SampleFigures | null,
): SampleFigures | null | undefined {
  if (reason !== 'sample') return sample === null ? null : undefined;
  if (
    sample === null ||
    !Number.isInteger(sample.percent) ||
    sample.percent < 1 ||
    sample.percent > 100 ||
    typeof sample.doubled !== 'boolean'
  ) {
    return undefined;
  }
  return { percent: sample.percent, doubled: sample.doubled };
}

/** Never earlier than `floor` (`offer_post_reviews_times_check`). */
function later(now: Temporal.Instant, floor: Temporal.Instant): Temporal.Instant {
  return Temporal.Instant.compare(now, floor) < 0 ? floor : now;
}
