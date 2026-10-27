import type { Result, Temporal } from '@mondapac/shared-kernel';
import type { ReadFailure } from './stripe-session-reader';

/**
 * What payments needs of a dispute, read again from Stripe with its PaymentIntent expanded. The
 * evidence, the buyer's claim and every card detail are never read.
 */
export interface DisputeSnapshot {
  /** dp_... (or du_... for an older dispute). */
  readonly id: string;
  readonly livemode: boolean;
  /** Stripe's status, as sent; the flow checks it against the known list. */
  readonly status: string;
  /** Stripe's reason, as sent; an unknown one is stored as `other`. */
  readonly reason: string;
  /** The disputed amount in minor units. */
  readonly amount: bigint;
  /** Lowercase ISO 4217, as Stripe sends it. */
  readonly currency: string;
  /** When Stripe opened the dispute. */
  readonly openedAt: Temporal.Instant;
  /** The deadline to answer in the Stripe Dashboard; null when Stripe gives none. */
  readonly evidenceDueBy: Temporal.Instant | null;
  /** A balance transaction of category `dispute` exists: the amount was taken from the platform. */
  readonly fundsWithdrawn: boolean;
  /** A balance transaction of category `dispute_reversal` exists: the amount came back. */
  readonly fundsReinstated: boolean;
  /** The charge's PaymentIntent and the metadata ordering set on it; null when it has none. */
  readonly paymentIntent: {
    readonly id: string;
    readonly metadataOrderId: string | null;
    readonly metadataMarketId: string | null;
  } | null;
}

/** Reads a dispute from Stripe; the webhook payload itself is never trusted. */
export interface StripeDisputeReader {
  readDispute(disputeId: string): Promise<Result<DisputeSnapshot, ReadFailure>>;
}

export const STRIPE_DISPUTE_READER = Symbol('STRIPE_DISPUTE_READER');
