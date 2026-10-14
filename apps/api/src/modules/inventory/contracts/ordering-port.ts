import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { InventoryBatchTooLarge, InventoryValidationFailed } from './inventory.facade';

// The ordering port of inventory (inventory design 7.2): the commands `ordering` sends. Only
// `modules/ordering` may import this file (dependency-cruiser rule
// `inventory-ordering-port-is-for-ordering`); inventory's `index.ts` does not export it. Slice 4
// holds the reservation commands; slice 5 adds commit, line cancellation and shipment.
// `getSellableExact` (design 7.2) is dropped: ordering commits before it captures payment, so a
// refusal is a void and no exact count is read.
// Every method takes the caller's `CallContext` unchanged, so the gate of the wrapped use case
// runs. No method carries a price or a Cost; the source chosen per line stays internal.

/** At most this many distinct lines in one `reserve` (design 4.2 step 1, Hassan finding 3). */
export const MAX_RESERVE_LINES = 50;

export interface ReserveLineRequest {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
}

export interface ReserveRequest {
  /** Ordering's id for this checkout; the idempotency key with the holder (design 10). */
  readonly checkoutRef: string;
  readonly lines: readonly ReserveLineRequest[];
}

export interface ReservedLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly reservationLineId: Id<'ReservationLine'>;
}

export interface ReserveResult {
  readonly reservationId: Id<'Reservation'>;
  readonly expiresAt: Temporal.Instant;
  readonly lines: readonly ReservedLine[];
}

/** Why one line could not be reserved; never a number (design 5.4). */
export type InsufficientReason = 'out' | 'not-enough' | 'over-limit' | 'retired';

export interface InventoryInsufficient {
  readonly code: 'inventory.insufficient';
  readonly details: {
    readonly lines: readonly {
      readonly offerId: Id<'Offer'>;
      readonly variantId: Id<'Variant'>;
      readonly reason: InsufficientReason;
    }[];
  };
}

/** A lock timeout, a deadlock or a same-holder race: nothing was held; try again. */
export interface ConflictRetry {
  readonly code: 'conflict.retry';
}

/** The holder spent the `reserve` budget (design 5.4); the call did nothing. */
export interface RequestThrottled {
  readonly code: 'request.throttled';
  readonly retryAfterSeconds: number;
}

/** The rate limiter could not answer; `reserve` fails closed (Hassan finding 6). */
export interface AccessUnavailable {
  readonly code: 'access.unavailable';
}

export type ReserveFailure =
  | AccessDenied
  | InventoryValidationFailed
  | InventoryBatchTooLarge
  | InventoryInsufficient
  | RequestThrottled
  | AccessUnavailable
  | ConflictRetry;

export type ReleaseFailure =
  | AccessDenied
  | InventoryValidationFailed
  /** Unknown, another customer's or another Market's: all one answer. */
  | { readonly code: 'inventory.reservation.not-found' }
  /** A committed reservation is released line by line (design 3.2), never as a whole. */
  | { readonly code: 'inventory.reservation.committed' }
  | ConflictRetry;

/** Why `ordering` releases a reservation on the system path (design 3.1). */
export type SystemReleaseCause = 'cancelled' | 'payment-failed';

export interface ReleaseResult {
  readonly reservationId: Id<'Reservation'>;
}

export interface CommitLine {
  readonly reservationLineId: string;
  /** Ordering's order line for the reserved line; the idempotency key of cancel and shipment. */
  readonly orderLineId: string;
}

export interface CommitRequest {
  readonly reservationId: string;
  /** Must equal the reservation's `checkoutRef` (Hassan finding 5). */
  readonly checkoutRef: string;
  /** Every line of the reservation, once (a subset is refused, design 3.2). */
  readonly lines: readonly CommitLine[];
}

export type CommitFailure =
  | AccessDenied
  | InventoryValidationFailed
  | { readonly code: 'inventory.reservation.not-found' }
  /** Another `checkoutRef`, lines or order lines than the reservation's or its earlier commit. */
  | { readonly code: 'inventory.commit-mismatch' }
  /** Nothing fits again, or the reservation was released for good: nothing was taken. */
  | InventoryInsufficient
  | ConflictRetry;

export type LineCommandFailure =
  | AccessDenied
  | InventoryValidationFailed
  /** No committed line has this order line. */
  | { readonly code: 'inventory.line.not-found' }
  /** Cancel after shipment, or shipment after cancel (design 10). */
  | { readonly code: 'inventory.line.final' }
  | ConflictRetry;

export interface InventoryOrderingPort {
  /** Customer actor only (rule `own-resources`); refused in an acting-as session. */
  reserve(
    context: CallContext,
    request: ReserveRequest,
  ): Promise<Result<ReserveResult, ReserveFailure>>;
  /** System actor only. */
  releaseReservation(
    context: CallContext,
    request: { readonly reservationId: string; readonly cause: SystemReleaseCause },
  ): Promise<Result<ReleaseResult, ReleaseFailure>>;
  /**
   * System actor only. ACTIVE to COMMITTED; an expired or superseded reservation is allocated
   * again under lock (design 3.1). Ordering calls it before it captures payment.
   */
  commitReservation(
    context: CallContext,
    request: CommitRequest,
  ): Promise<Result<ReleaseResult, CommitFailure>>;
  /** System actor only. COMMITTED to CANCELLED: the units are sellable again. */
  cancelCommittedLine(
    context: CallContext,
    request: { readonly orderLineId: string },
  ): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>>;
  /** System actor only. COMMITTED to FULFILLED: the source's on-hand goes down by the quantity. */
  recordShipment(
    context: CallContext,
    request: { readonly orderLineId: string },
  ): Promise<Result<{ readonly orderLineId: string }, LineCommandFailure>>;
  /** The holder's own reservation (cause `customer`). */
  releaseOwnReservation(
    context: CallContext,
    request: { readonly reservationId: string },
  ): Promise<Result<ReleaseResult, ReleaseFailure>>;
}

/** Nest token of the {@link InventoryOrderingPort}, provided and exported by `InventoryModule`. */
export const INVENTORY_ORDERING_PORT = Symbol('INVENTORY_ORDERING_PORT');
