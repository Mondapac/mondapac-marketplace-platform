import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { PriceAmount } from './price-amount';
import type { HoldRejectionReason, JumpAnchor, SupersedeCause } from './record-types';

// Special (time-windowed) prices of a price series (pricing design 2.1, 3.2, 4.1, 4.3). Pure
// types and helpers; the aggregate methods that change them are on `PriceSeries`.

export type SpecialRecordStatus =
  'ACCEPTED' | 'APPROVED' | 'PENDING_REVIEW' | 'REJECTED' | 'SUPERSEDED' | 'WITHDRAWN';

/**
 * Why a running or scheduled special stopped before its end: the seller ended it, a newer special
 * replaced it, or its series was retired.
 */
export type WithdrawCause = 'withdrawn' | 'replaced' | 'offer-removed' | 'variant-removed';

/** The regular price in effect when a special was written, copied so it never changes. */
export interface SpecialRegularRef {
  readonly recordId: Id<'RegularPriceRecord'>;
  readonly amount: PriceAmount;
}

/** Who decided a held special, when and why; the same shape as a regular record's decision. */
export interface SpecialDecision {
  readonly decidedAt: Temporal.Instant;
  readonly decidedBy: Id<'Account'>;
  readonly reasonCode: HoldRejectionReason | null;
  readonly note: string | null;
}

/**
 * One special price record (pricing design 2.1). Content never changes; only the status and the
 * decision, supersede and withdraw fields move, each once. "Ended" is derived (`endsAt <= now`),
 * never stored.
 */
export interface SpecialPriceRecord {
  readonly id: Id<'SpecialPriceRecord'>;
  readonly amount: PriceAmount;
  readonly taxInclusive: boolean;
  readonly status: SpecialRecordStatus;
  /** The window the seller asked for (UTC instants). `endsAt > startsAt`. */
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
  readonly submittedAt: Temporal.Instant;
  readonly submittedBy: Id<'Account'>;
  /** The effective regular price when it was written (design 3.2: strictly above the special). */
  readonly regular: SpecialRegularRef;
  /** The regular jump anchor (design 2.4) when it was written; the hold is measured against it. */
  readonly anchor: JumpAnchor;
  /** `down` for a held special, null for an accepted one. */
  readonly heldDirection: 'down' | null;
  /** Set when the special becomes effective: `max(startsAt, approval)`; null while pending. */
  readonly effectiveFrom: Temporal.Instant | null;
  readonly withdrawnAt: Temporal.Instant | null;
  readonly withdrawCause: WithdrawCause | null;
  readonly supersededBy: Id<'SpecialPriceRecord'> | null;
  readonly supersededAt: Temporal.Instant | null;
  readonly supersedeCause: SupersedeCause | null;
  /** Set for `APPROVED` and `REJECTED` records, and a withdrawn record that was approved. */
  readonly decision: SpecialDecision | null;
}

/**
 * What a held special was measured against: the larger of the regular price and the regular jump
 * anchor it carries (the larger explains the hold; the queue and the audit rows show it).
 */
export function holdReference(record: SpecialPriceRecord): SpecialRegularRef {
  return record.anchor.amount.amount > record.regular.amount.amount
    ? record.anchor
    : record.regular;
}

/** The end of a special's effective period: `min(endsAt, withdrawnAt)`. */
export function specialEnd(record: SpecialPriceRecord): Temporal.Instant {
  if (record.withdrawnAt === null) return record.endsAt;
  return Temporal.Instant.compare(record.withdrawnAt, record.endsAt) < 0
    ? record.withdrawnAt
    : record.endsAt;
}

/** A record that has been, or is, a special in force (never pending, rejected or superseded). */
export function isSpecialPriced(record: SpecialPriceRecord): boolean {
  return (
    record.effectiveFrom !== null &&
    (record.status === 'ACCEPTED' || record.status === 'APPROVED' || record.status === 'WITHDRAWN')
  );
}

/**
 * The special whose effective period `[effectiveFrom, min(endsAt, withdrawnAt))` contains `at`
 * (pricing design 4.1 step 3), or null. At most one exists, by the series invariant.
 */
export function specialInForce(
  records: readonly SpecialPriceRecord[],
  at: Temporal.Instant,
): SpecialPriceRecord | null {
  for (const record of records) {
    if (!isSpecialPriced(record)) continue;
    if (Temporal.Instant.compare(record.effectiveFrom as Temporal.Instant, at) > 0) continue;
    if (Temporal.Instant.compare(specialEnd(record), at) <= 0) continue;
    return record;
  }
  return null;
}

/**
 * A running or scheduled special: accepted or approved, not withdrawn and not ended at `at`
 * (pricing design 3.1 row 1, Q2, Q3). A regular price must stay strictly above it; a new special
 * replaces it.
 */
export function liveOrScheduledSpecial(
  records: readonly SpecialPriceRecord[],
  at: Temporal.Instant,
): SpecialPriceRecord | null {
  return (
    records.find(
      (r) =>
        (r.status === 'ACCEPTED' || r.status === 'APPROVED') &&
        r.withdrawnAt === null &&
        Temporal.Instant.compare(r.endsAt, at) > 0,
    ) ?? null
  );
}
