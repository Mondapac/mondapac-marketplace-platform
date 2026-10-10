import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { InventoryBatchTooLarge, InventoryValidationFailed } from './inventory.facade';

// The ordering port of inventory (inventory design 7.2): the commands `ordering` sends. Only
// `modules/ordering` may import this file (dependency-cruiser rule
// `inventory-ordering-port-is-for-ordering`); inventory's `index.ts` does not export it. Slice 4
// holds the reservation commands. Commit, line cancellation and shipment arrive with slice 5.
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

export type ReserveFailure =
  | AccessDenied
  | InventoryValidationFailed
  | InventoryBatchTooLarge
  | InventoryInsufficient
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
  /** The holder's own reservation (cause `customer`). */
  releaseOwnReservation(
    context: CallContext,
    request: { readonly reservationId: string },
  ): Promise<Result<ReleaseResult, ReleaseFailure>>;
}

/** Nest token of the {@link InventoryOrderingPort}, provided and exported by `InventoryModule`. */
export const INVENTORY_ORDERING_PORT = Symbol('INVENTORY_ORDERING_PORT');
