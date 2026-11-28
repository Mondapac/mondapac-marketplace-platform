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
 * has failed: the delivery comes due again after its back-off, unless it said so on purpose with
 * {@link deliveredWithoutInbox} and opened no `runOnce` (BUG-015).
 */
export interface EventDelivery {
  readonly eventId: Id<'event'>;
  /** The subscription's name, `<module>.<handler>`: also the inbox's `handler`. */
  readonly subscriber: string;
  /** This claim's number, from 1 (P 6.4: the claim counts the attempt). */
  readonly attempt: number;
}

/** Deliveries their handler finished with nothing to record in an inbox (BUG-015). */
const withoutInbox = new WeakSet<EventDelivery>();

/**
 * Says that the handler finished this delivery on purpose without a `runOnce` (BUG-015): an event
 * it skips (another population, a scope it does not serve), or a converging re-read that needs no
 * inbox row (a subscription declared `inbox: 'none'` does this after its handler returns). The
 * dispatcher then marks the delivery delivered. Without it, a handler that returns without a
 * committed `runOnce` still fails, so a forgotten `runOnce` stays visible. A delivery whose
 * `runOnce` was opened and did not commit fails whatever this says.
 */
export function deliveredWithoutInbox(delivery: EventDelivery): void {
  withoutInbox.add(delivery);
}

/** Whether {@link deliveredWithoutInbox} was called with this very handle. */
export function isDeliveredWithoutInbox(delivery: EventDelivery): boolean {
  return withoutInbox.has(delivery);
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

/**
 * The longest one handler may take (Mojtaba F1, C2): a read unit (5 s unit timeout + 2 s
 * connection wait), an external call bounded by its own timeout (mail: 5 s) and a `runOnce` unit
 * (5 s + 2 s): 19 s, rounded up. A claimed row is handed to its handler only while this much of
 * its lease is left, so it is never claimed again by another dispatcher while its handler runs.
 */
export const HANDLER_BUDGET_MS = 20_000;

/** P 6.4: `min(30 s × 2^(attempts − 1), 1 h)` after the claim that counted `attempts`. */
export function backOffSeconds(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError('attempts starts at 1');
  return Math.min(BACK_OFF_BASE_SECONDS * 2 ** Math.min(attempts - 1, 20), BACK_OFF_MAX_SECONDS);
}

/** When a delivery claimed at `now` for the `attempts`-th time comes due again. */
export function nextAttemptAfter(now: Temporal.Instant, attempts: number): Temporal.Instant {
  return now.add({ seconds: backOffSeconds(attempts) });
}
