import type { Id, Temporal } from '@mondapac/shared-kernel';

/**
 * One delivery of one event to one subscriber, as the dispatcher hands it to the handler
 * (platform persistence design, "P", 6.4). The handler passes it unchanged to its use case,
 * which opens its unit with `UnitOfWork.runOnce(market, delivery, work)`: that unit records
 * the event in the module's inbox and marks this delivery delivered, in the one transaction
 * of the work (ADR-0006 decision 5).
 *
 * Only the dispatcher creates one, and `runOnce` refuses a delivery it did not create, so a
 * module cannot forge or reuse one. A handler that returns without a `runOnce` that committed
 * has failed: the delivery comes due again after its back-off.
 */
export interface EventDelivery {
  readonly eventId: Id<'event'>;
  /** The subscription's name, `<module>.<handler>`: also the inbox's `handler`. */
  readonly subscriber: string;
  /** This claim's number, from 1 (P 6.4: the claim counts the attempt). */
  readonly attempt: number;
}

/** What one dispatcher pass did: deliveries claimed, and whether a batch was full. */
export interface DispatchPass {
  readonly claimed: number;
  readonly fullBatch: boolean;
}

/**
 * The consume side of the in-process event bus (P 6.4), as the worker runs it: one pass claims
 * the due deliveries of every hosted Market and runs their handlers. Implemented in
 * `platform/persistence/outbox/`.
 */
export interface EventDispatcher {
  runOnce(): Promise<DispatchPass>;
}

/** Nest token of the {@link EventDispatcher}. */
export const EVENT_DISPATCHER = Symbol('EVENT_DISPATCHER');

/** Deliveries per claim and Market. */
export const DISPATCH_BATCH_SIZE = 20;
/** After this many claims a failing delivery becomes `dead` (P 6.4: about three hours). */
export const MAX_DELIVERY_ATTEMPTS = 10;
/** The first back-off and its cap (P 6.4); never less than the unit timeout of 5 s. */
export const BACK_OFF_BASE_SECONDS = 30;
export const BACK_OFF_MAX_SECONDS = 3600;

/** P 6.4: `min(30 s × 2^(attempts − 1), 1 h)` after the claim that counted `attempts`. */
export function backOffSeconds(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts starts at 1');
  return Math.min(BACK_OFF_BASE_SECONDS * 2 ** Math.min(attempts - 1, 20), BACK_OFF_MAX_SECONDS);
}

/** When a delivery claimed at `now` for the `attempts`-th time comes due again. */
export function nextAttemptAfter(now: Temporal.Instant, attempts: number): Temporal.Instant {
  return now.add({ seconds: backOffSeconds(attempts) });
}
