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
/** The platform's events the receiver keeps: Checkout, disputes (8a) and transfers (6c). */
export const PLATFORM_EVENT_TYPES = [
  ...CHECKOUT_EVENT_TYPES,
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
  /** The Checkout session (cs_...), dispute (dp_..., du_...), transfer (tr_...) or account (acct_...). */
  readonly objectId: string;
  readonly receivedAt: Temporal.Instant;
}

/** A stored event waiting to be applied. */
export interface PendingEvent extends ReceivedEvent {
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

  /** Marks an unapplied event done; false when it was already done. */
  finish(
    market: MarketContext,
    eventId: string,
    outcome: EventOutcome,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /** Counts a failed attempt of an unapplied event and sets when to try again. */
  retryLater(
    market: MarketContext,
    eventId: string,
    attempts: number,
    nextAttemptAt: Temporal.Instant,
  ): Promise<void>;
}

export const STRIPE_EVENT_INBOX = Symbol('STRIPE_EVENT_INBOX');
