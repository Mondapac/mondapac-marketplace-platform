import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';

/**
 * A seller's Offer review standing in a Market (risk-based Offer approval slice 4; ADR-0051
 * decision 4, design 5): probation progress and Trusted. One per Market and seller, created lazily
 * by the first unit that needs it, never deleted.
 *
 * The count is the number of credits in the current epoch (one per product, stored apart); the
 * target is N (`initial`) or ceil(N/2) (`after-misconduct`), with N read at decision time. Two
 * Changes needed in a row restart the epoch; a misconduct takedown (slice 6) revokes Trusted and
 * opens an after-misconduct epoch. Nothing ever lowers the count.
 *
 * The database guard (`catalog.seller_review_standings_guard`) holds the same transitions: the
 * epoch only moves forward by one, a new epoch starts in probation, `trusted_at` is cleared only
 * by a revocation.
 */

export const STANDING_TARGET_KINDS = ['initial', 'after-misconduct'] as const;
export type StandingTargetKind = (typeof STANDING_TARGET_KINDS)[number];

/** N when the setting cannot be read or is out of its bounds (the setting's safe value). */
export const SAFE_PROBATION_OFFERS = 100;
/** The setting's bounds (`offer-review-probation-offers`, 0 to 100). */
const MAX_PROBATION_OFFERS = 100;

export interface SellerReviewStandingState {
  readonly marketId: MarketId;
  readonly sellerId: Id<'Seller'>;
  /** Starts at 1; +1 on a restart or a misconduct revocation. */
  readonly epoch: number;
  readonly targetKind: StandingTargetKind;
  /** Changes needed in a row in probation: 0 or 1 (the second restarts the epoch). */
  readonly consecutiveChangesNeeded: 0 | 1;
  /** Set when the seller reached the target; cleared only by a misconduct revocation. */
  readonly trustedAt: Temporal.Instant | null;
  /** The last misconduct revocation. */
  readonly trustLostAt: Temporal.Instant | null;
  /** The stored version; the repository raises it by exactly one per write. */
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** N as a whole number from 0 to 100; anything else is the safe 100. */
export function probationOffersOf(n: number): number {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_PROBATION_OFFERS ? n : SAFE_PROBATION_OFFERS;
}

/** The count a seller must reach: N at first, ceil(N/2) after a misconduct revocation. */
export function probationTarget(kind: StandingTargetKind, probationOffers: number): number {
  const n = probationOffersOf(probationOffers);
  return kind === 'initial' ? n : Math.ceil(n / 2);
}

function assertCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('standing: bad count');
}

export class SellerReviewStanding {
  #state: SellerReviewStandingState;
  #changed = false;

  private constructor(state: SellerReviewStandingState) {
    this.#state = state;
  }

  /** A new standing: epoch 1, target N, in probation. The row is inserted at version 1. */
  static start(input: {
    readonly marketId: MarketId;
    readonly sellerId: Id<'Seller'>;
    readonly now: Temporal.Instant;
  }): SellerReviewStanding {
    return new SellerReviewStanding({
      marketId: input.marketId,
      sellerId: input.sellerId,
      epoch: 1,
      targetKind: 'initial',
      consecutiveChangesNeeded: 0,
      trustedAt: null,
      trustLostAt: null,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(state: SellerReviewStandingState): SellerReviewStanding {
    return new SellerReviewStanding(state);
  }

  get state(): SellerReviewStandingState {
    return this.#state;
  }

  /** True when a command changed the state since it was loaded: the unit must save it. */
  get changed(): boolean {
    return this.#changed;
  }

  #set(patch: Partial<SellerReviewStandingState>, now: Temporal.Instant): void {
    this.#state = { ...this.#state, ...patch, updatedAt: now };
    this.#changed = true;
  }

  /**
   * An admin approved a first publication of this seller (the `offer.approve` unit), after its
   * credit was written: `count` is the number of credits in the current epoch now. Only in
   * probation: it breaks a row of Changes needed and stamps `trustedAt` once the target is met.
   */
  recordApproval(input: {
    readonly count: number;
    readonly probationOffers: number;
    readonly now: Temporal.Instant;
  }): 'ignored' | 'counted' | 'trusted' {
    assertCount(input.count);
    if (this.#state.trustedAt !== null) return 'ignored';
    const target = probationTarget(this.#state.targetKind, input.probationOffers);
    if (input.count >= target) {
      this.#set({ trustedAt: input.now, consecutiveChangesNeeded: 0 }, input.now);
      return 'trusted';
    }
    if (this.#state.consecutiveChangesNeeded !== 0) {
      this.#set({ consecutiveChangesNeeded: 0 }, input.now);
    }
    return 'counted';
  }

  /**
   * An admin asked for changes on a first publication of this seller (the
   * `offer.request-changes` unit). Only in probation; the second in a row (seller-wide) starts a
   * new epoch with a count of 0.
   */
  recordChangesNeeded(input: {
    readonly now: Temporal.Instant;
  }): 'ignored' | 'counted' | 'restarted' {
    if (this.#state.trustedAt !== null) return 'ignored';
    if (this.#state.consecutiveChangesNeeded === 0) {
      this.#set({ consecutiveChangesNeeded: 1 }, input.now);
      return 'counted';
    }
    this.#set({ epoch: this.#state.epoch + 1, consecutiveChangesNeeded: 0 }, input.now);
    return 'restarted';
  }

  /**
   * A misconduct takedown (slice 6 wires it; automatic takedowns never call it): Trusted is lost,
   * a new epoch opens with the after-misconduct target, and `trustLostAt` is now, so a
   * Trusted-from-start switch made before it no longer counts.
   */
  revokeForMisconduct(input: { readonly now: Temporal.Instant }): 'revoked' {
    const last = this.#state.trustLostAt;
    if (last !== null && Temporal.Instant.compare(input.now, last) <= 0) {
      throw new RangeError('standing: a revocation must come after the last one');
    }
    this.#set(
      {
        epoch: this.#state.epoch + 1,
        targetKind: 'after-misconduct',
        trustedAt: null,
        trustLostAt: input.now,
        consecutiveChangesNeeded: 0,
      },
      input.now,
    );
    return 'revoked';
  }

  /**
   * The count already meets the target (N was lowered since the last approval): stamp
   * `trustedAt` now (the submit unit does, design 5), so raising N later never demotes the
   * seller. True when it stamped.
   */
  stampTrust(input: {
    readonly count: number;
    readonly probationOffers: number;
    readonly now: Temporal.Instant;
  }): boolean {
    assertCount(input.count);
    if (this.#state.trustedAt !== null) return false;
    if (input.count < probationTarget(this.#state.targetKind, input.probationOffers)) return false;
    this.#set({ trustedAt: input.now, consecutiveChangesNeeded: 0 }, input.now);
    return true;
  }
}

/** What {@link trustStatusOf} reads of a standing: its state and the current epoch's count. */
export interface StandingFacts {
  readonly targetKind: StandingTargetKind;
  readonly trustedAt: Temporal.Instant | null;
  readonly trustLostAt: Temporal.Instant | null;
  readonly count: number;
}

/** The seller's Trusted-from-start switch (sellers, SEL-25): on, and when it was last changed. */
export interface TrustFlags {
  readonly trustedFromStart: { readonly on: boolean; readonly at: Temporal.Instant | null };
}

export interface TrustStatus {
  readonly status: 'trusted' | 'probation';
  /** `count`: earned in probation; `admin`: Trusted from start. Null in probation. */
  readonly source: 'count' | 'admin' | null;
  /**
   * When Trusted began: `trustedAt`, or the switch's change time. The start of slice 6's 30 days
   * of double sampling. Null in probation, and when Trusted by a count the submit unit has not
   * stamped yet (N was lowered).
   */
  readonly trustedSince: Temporal.Instant | null;
  readonly count: number;
  readonly target: number;
}

/**
 * Trusted or in probation (pure; design 5): Trusted when `trustedAt` is set, when an admin's
 * Trusted-from-start switch was turned on after the last misconduct revocation, or when the
 * current count meets the target with N read now (N lowered). Raising N never demotes a stamped
 * seller; turning the switch off returns the seller to probation with its current count. A
 * seller with no standing yet has a count of 0 and the initial target.
 */
export function trustStatusOf(
  standing: StandingFacts | null,
  flags: TrustFlags,
  probationOffers: number,
): TrustStatus {
  const count = standing?.count ?? 0;
  const target = probationTarget(standing?.targetKind ?? 'initial', probationOffers);
  const base = { count, target };
  if (standing?.trustedAt != null) {
    return { status: 'trusted', source: 'count', trustedSince: standing.trustedAt, ...base };
  }
  const flag = flags.trustedFromStart;
  const lost = standing?.trustLostAt ?? null;
  if (
    flag.on &&
    flag.at !== null &&
    (lost === null || Temporal.Instant.compare(flag.at, lost) > 0)
  ) {
    return { status: 'trusted', source: 'admin', trustedSince: flag.at, ...base };
  }
  if (count >= target) return { status: 'trusted', source: 'count', trustedSince: null, ...base };
  return { status: 'probation', source: null, trustedSince: null, ...base };
}
