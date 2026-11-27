import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import { DISPUTE_EVENT_TYPES } from '../../domain/dispute';
import { EXTERNAL_ACCOUNT_EVENT_TYPES } from '../../domain/payout-change';
import { TRANSFER_EVENT_TYPES } from '../../domain/transfer';

/** The platform's Checkout events the receiver keeps; every other platform type is dropped. */
export const CHECKOUT_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
] as const;
/**
 * The PaymentIntent events of a card payment made on the MondaPac page (checkout payment API):
 * the card holds the money, the payment failed, or the PaymentIntent was cancelled.
 */
export const CARD_PAYMENT_EVENT_TYPES = [
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
] as const;
export const isCardPaymentEventType = (
  type: string,
): type is (typeof CARD_PAYMENT_EVENT_TYPES)[number] =>
  (CARD_PAYMENT_EVENT_TYPES as readonly string[]).includes(type);
/** The platform's events the receiver keeps: Checkout, card payments, disputes (8a), transfers (6c). */
export const PLATFORM_EVENT_TYPES = [
  ...CHECKOUT_EVENT_TYPES,
  ...CARD_PAYMENT_EVENT_TYPES,
  ...DISPUTE_EVENT_TYPES,
  ...TRANSFER_EVENT_TYPES,
] as const;
/**
 * The connected-account events (Connect endpoint) the receiver keeps. `balance_settings.updated`
 * is the one Stripe sends when an account's payout schedule changes (F-3 record (b), Hassan's
 * HP-1 re-check): the account is read again, so a schedule changed outside payments while a pause
 * holds is paused again at once, not only at the daily reconciliation.
 */
export const ACCOUNT_EVENT_TYPES = [
  'account.updated',
  'capability.updated',
  'balance_settings.updated',
  ...EXTERNAL_ACCOUNT_EVENT_TYPES,
] as const;
export const KEPT_EVENT_TYPES = [...PLATFORM_EVENT_TYPES, ...ACCOUNT_EVENT_TYPES] as const;
export type KeptEventType = (typeof KEPT_EVENT_TYPES)[number];
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

export const isAccountEventType = (type: KeptEventType): type is AccountEventType =>
  (ACCOUNT_EVENT_TYPES as readonly string[]).includes(type);

/** How a kept event ended. */
export type EventOutcome =
  | 'confirmed'
  | 'already-confirmed'
  | 'voided'
  | 'cancelled'
  /** Nothing to do (for example the payment is no longer held). */
  | 'ignored'
  /** The object Stripe returned does not fit this Market or order: never applied. */
  | 'rejected'
  /** A connected account's state was read again and stored. */
  | 'account-updated'
  /** A dispute was read again and its new state stored (package 8a). */
  | 'dispute-recorded'
  /** A transfer was read again and its state stored (package 6c). */
  | 'transfer-recorded'
  /** A dispute of another Market's order: Stripe sends it to every endpoint, nothing is stored. */
  | 'other-market'
  /** Gave up after the last attempt; needs an admin. */
  | 'failed';

/** A verified event as the receiver stores it: ids and type only, no body and no card data. */
export interface ReceivedEvent {
  readonly eventId: string;
  readonly type: KeptEventType;
  /** The Checkout session (cs_...), PaymentIntent (pi_...), dispute (dp_..., du_...), transfer (tr_...) or account (acct_...). */
  readonly objectId: string;
  readonly receivedAt: Temporal.Instant;
}

/** A stored event waiting to be applied. */
export interface PendingEvent extends ReceivedEvent {
  /** Attempts started so far (taken by `claim`), not attempts that failed. */
  readonly attempts: number;
}

/**
 * The inbox of verified Stripe events of one Market (`payments.stripe_events`): the event id is
 * the key, so a repeated delivery is stored once. Runs inside the caller's unit of work.
 */
export interface StripeEventInbox {
  /** Stores the event once; `duplicate` when its id is already stored for this Market. */
  record(market: MarketContext, event: ReceivedEvent): Promise<'recorded' | 'duplicate'>;

  /** The oldest unapplied events whose next attempt is due, at most `limit`. */
  due(market: MarketContext, now: Temporal.Instant, limit: number): Promise<PendingEvent[]>;

  /**
   * Takes the next attempt of an unapplied event before it is applied, in a unit of its own:
   * `attempts` becomes `expectedAttempts + 1` and the next attempt is set, only while the row is
   * unapplied and still has `expectedAttempts`. So an attempt is counted, and the event moves back
   * in the queue, even when applying it throws or the process dies half-way; and of two runs that
   * overlap only one takes it. True when this run took it.
   */
  claim(
    market: MarketContext,
    eventId: string,
    expectedAttempts: number,
    nextAttemptAt: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Marks an unapplied event done, only while it still has `attempts` (the attempt this run took),
   * so a late run never overwrites the outcome of a newer one; false otherwise.
   */
  finish(
    market: MarketContext,
    eventId: string,
    outcome: EventOutcome,
    at: Temporal.Instant,
    attempts: number,
  ): Promise<boolean>;
}

export const STRIPE_EVENT_INBOX = Symbol('STRIPE_EVENT_INBOX');
