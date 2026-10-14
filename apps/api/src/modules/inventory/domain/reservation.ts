import { err, ok, Temporal, type Id, type Result } from '@mondapac/shared-kernel';

// The Reservation aggregate (inventory design 2.1, 3.1, 3.2): the holding phase, the commit
// decision and the line states after commit. No storage, no clock: the use case passes the
// instants it took from the injected Clock.

export type ReservationStatus = 'active' | 'released' | 'expired' | 'committed';

/** Why a reservation was released (design 2.1, 3.1, 3.6). */
export const RELEASE_CAUSES = [
  'superseded',
  'cancelled',
  'payment-failed',
  'customer',
  'offer-moved',
] as const;
export type ReleaseCause = (typeof RELEASE_CAUSES)[number];

/** Until commit a line mirrors its header; after commit it has its own states (design 3.2). */
export type ReservationLineStatus =
  'active' | 'released' | 'expired' | 'committed' | 'fulfilled' | 'cancelled';

export interface ReservationLineState {
  readonly id: Id<'ReservationLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  /** The allocated unit; its source and seller are the item's. */
  readonly stockItemId: Id<'StockItem'>;
  readonly quantity: number;
  readonly status: ReservationLineStatus;
  /** Ordering's order line (design 3.1); set from commit on, null before. */
  readonly orderLineId: string | null;
}

export interface ReservationState {
  readonly id: Id<'Reservation'>;
  readonly holderAccountId: Id<'Account'>;
  readonly checkoutRef: string;
  readonly status: ReservationStatus;
  readonly releaseCause: ReleaseCause | null;
  readonly expiresAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly statusChangedAt: Temporal.Instant;
  readonly version: number;
  readonly lines: readonly ReservationLineState[];
}

export interface NewReservationLine {
  readonly id: Id<'ReservationLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly stockItemId: Id<'StockItem'>;
  readonly quantity: number;
}

export interface PlaceReservation {
  readonly id: Id<'Reservation'>;
  readonly holderAccountId: Id<'Account'>;
  readonly checkoutRef: string;
  readonly lines: readonly NewReservationLine[];
  readonly now: Temporal.Instant;
  /** The Market's reservation duration (design 8). */
  readonly duration: Temporal.Duration;
}

/** What a release did: changed the status, or found it already final (design 10). */
export type ReleaseOutcome = 'released' | 'unchanged';

export class ReservationCommitted extends Error {
  override readonly name = 'ReservationCommitted';
}

/** A reservation: one customer's hold on stock for one checkout. Immutable; transitions return the next. */
export class Reservation {
  private constructor(readonly state: ReservationState) {}

  static fromStored(state: ReservationState): Reservation {
    return new Reservation(state);
  }

  /** (none) to ACTIVE: `expiresAt` = `createdAt` + the Market's duration (design 2.1). */
  static place(input: PlaceReservation): Reservation {
    const { now } = input;
    return new Reservation({
      id: input.id,
      holderAccountId: input.holderAccountId,
      checkoutRef: input.checkoutRef,
      status: 'active',
      releaseCause: null,
      expiresAt: now.add(input.duration),
      createdAt: now,
      statusChangedAt: now,
      version: 1,
      lines: input.lines.map((line) => ({ ...line, status: 'active' as const, orderLineId: null })),
    });
  }

  /**
   * Expiry is derived at read: an ACTIVE reservation stops counting at `now >= expiresAt` whether
   * or not the cleanup job has set the status yet (design 3.1, 4.1).
   */
  isLiveAt(now: Temporal.Instant): boolean {
    return (
      this.state.status === 'active' && Temporal.Instant.compare(now, this.state.expiresAt) < 0
    );
  }

  isExpiredAt(now: Temporal.Instant): boolean {
    return this.state.status === 'active' && !this.isLiveAt(now);
  }

  /** Same checkout and the same sell units and quantities: the idempotent `reserve` replay (design 10). */
  matches(
    checkoutRef: string,
    lines: readonly { offerId: string; variantId: string; quantity: number }[],
  ): boolean {
    if (this.state.checkoutRef !== checkoutRef || this.state.lines.length !== lines.length) {
      return false;
    }
    const mine = new Map(
      this.state.lines.map((line) => [`${line.offerId}/${line.variantId}`, line.quantity]),
    );
    return lines.every((line) => mine.get(`${line.offerId}/${line.variantId}`) === line.quantity);
  }

  /**
   * ACTIVE to RELEASED with its cause, also when the clock is past `expiresAt` but the job has not
   * run (a newer `reserve` supersedes an expired one, design 3.1). A reservation already RELEASED
   * or EXPIRED stays as it is, with its stored cause (design 10); a COMMITTED one is refused
   * (cancel a line instead, design 3.2).
   */
  release(
    cause: ReleaseCause,
    now: Temporal.Instant,
  ): Result<{ outcome: ReleaseOutcome; next: Reservation }, ReservationCommitted> {
    const { status } = this.state;
    if (status === 'committed') return err(new ReservationCommitted());
    if (status !== 'active') return ok({ outcome: 'unchanged', next: this });
    return ok({
      outcome: 'released',
      next: new Reservation({
        ...this.state,
        status: 'released',
        releaseCause: cause,
        statusChangedAt: now,
        version: this.state.version + 1,
        lines: this.state.lines.map((line) => ({ ...line, status: 'released' as const })),
      }),
    });
  }

  /** ACTIVE to EXPIRED once `now >= expiresAt`; anything else is not due (the job's guard, design 11). */
  expire(now: Temporal.Instant): Reservation | null {
    if (!this.isExpiredAt(now)) return null;
    return new Reservation({
      ...this.state,
      status: 'expired',
      statusChangedAt: now,
      version: this.state.version + 1,
      lines: this.state.lines.map((line) => ({ ...line, status: 'expired' as const })),
    });
  }

  /**
   * What `commitReservation` must do (design 3.1, 10). The `checkoutRef` and the mapping must fit
   * first: the mapping names every line of the reservation exactly once, with distinct order
   * lines (committing a subset is forbidden, design 3.2). Then:
   * - COMMITTED with the same mapping: nothing to do; another mapping is a mismatch;
   * - ACTIVE and still live: commit the lines where they are;
   * - ACTIVE past its expiry, EXPIRED, or RELEASED as `superseded`: allocate the same lines again
   *   under lock (Ali, Q-A2);
   * - RELEASED with any other cause: final, refused.
   */
  decideCommit(
    checkoutRef: string,
    mapping: readonly CommitMapping[],
    now: Temporal.Instant,
  ): CommitDecision {
    if (this.state.checkoutRef !== checkoutRef) return 'mismatch';
    const byLine = new Map(mapping.map((entry) => [entry.reservationLineId as string, entry]));
    const orderLines = new Set(mapping.map((entry) => entry.orderLineId));
    if (
      byLine.size !== mapping.length ||
      orderLines.size !== mapping.length ||
      mapping.length !== this.state.lines.length ||
      !this.state.lines.every((line) => byLine.has(line.id))
    ) {
      return 'mismatch';
    }
    const { status } = this.state;
    if (status === 'committed') {
      const same = this.state.lines.every(
        (line) => line.orderLineId === byLine.get(line.id)?.orderLineId,
      );
      return same ? 'already-committed' : 'mismatch';
    }
    if (status === 'released')
      return this.state.releaseCause === 'superseded' ? 'reallocate' : 'refused';
    if (status === 'expired') return 'reallocate';
    return this.isLiveAt(now) ? 'commit-in-place' : 'reallocate';
  }
}

/** One line of a commit: the reservation line and the order line that now owns its units. */
export interface CommitMapping {
  readonly reservationLineId: Id<'ReservationLine'>;
  readonly orderLineId: string;
}

export type CommitDecision =
  'mismatch' | 'already-committed' | 'refused' | 'commit-in-place' | 'reallocate';

/** What a committed line does on a cancel or a shipment (design 3.2, 10). */
export type LineTransition = 'apply' | 'unchanged' | 'refused';

/** COMMITTED to CANCELLED; CANCELLED again is fine; a FULFILLED line cannot be cancelled. */
export function cancelLineDecision(status: ReservationLineStatus): LineTransition {
  if (status === 'committed') return 'apply';
  return status === 'cancelled' ? 'unchanged' : 'refused';
}

/** COMMITTED to FULFILLED; FULFILLED again is fine; a CANCELLED line cannot ship. */
export function shipLineDecision(status: ReservationLineStatus): LineTransition {
  if (status === 'committed') return 'apply';
  return status === 'fulfilled' ? 'unchanged' : 'refused';
}
