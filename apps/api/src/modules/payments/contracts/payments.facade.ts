import type { CallContext, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** Whether Stripe can pay one seller. */
export interface PayoutReadiness {
  readonly sellerId: string;
  readonly ready: boolean;
}

/** Stripe's dispute statuses; `warning_*` is an inquiry. */
export type DisputeStatus =
  | 'warning_needs_response'
  | 'warning_under_review'
  | 'warning_closed'
  | 'needs_response'
  | 'under_review'
  | 'won'
  | 'lost'
  | 'prevented';

/** One dispute of an order, as payments stored it from Stripe (package 8a). */
export interface Dispute {
  readonly disputeId: string;
  readonly orderId: string;
  /** Stripe's dispute id, for the Stripe Dashboard link; evidence is answered there (decision 6). */
  readonly providerDisputeId: string;
  /** The disputed amount. */
  readonly amount: Money;
  readonly status: DisputeStatus;
  /** Stripe's reason code (`other` for one payments does not know); never the buyer's text. */
  readonly reason: string;
  /** An inquiry: no money is withdrawn while it stays one. */
  readonly inquiry: boolean;
  /** The deadline to answer in the Stripe Dashboard; null when Stripe gives none. */
  readonly evidenceDueBy: Temporal.Instant | null;
  /** The amount was taken from the platform (moves only from false to true). */
  readonly fundsWithdrawn: boolean;
  readonly fundsWithdrawnAt: Temporal.Instant | null;
  /** The amount came back (moves only from false to true). */
  readonly fundsReinstated: boolean;
  readonly fundsReinstatedAt: Temporal.Instant | null;
  /** Set once when Stripe closes a chargeback as won or lost. */
  readonly outcome: 'won' | 'lost' | null;
  readonly openedAt: Temporal.Instant;
  /** The version of the latest `payments.dispute-changed.v1` of this dispute. */
  readonly version: number;
}

/**
 * What other modules ask of `payments`. Takes the caller's `CallContext` unchanged, so the
 * use case's gate runs.
 */
export interface PaymentsFacade {
  /**
   * For up to 100 seller ids, whether the stored payout account is enabled. Answers from the
   * stored state, with no call to Stripe; an unknown seller (or one of another Market) is
   * `ready: false`.
   */
  payoutReadiness(
    context: CallContext,
    sellerIds: readonly string[],
  ): Promise<
    Result<readonly PayoutReadiness[], AccessDenied | { readonly code: 'validation.failed' }>
  >;

  /**
   * For up to 100 dispute ids (from `payments.dispute-changed.v1`), the stored disputes. Answers
   * from the stored state, with no call to Stripe; an unknown id (or one of another Market) is
   * left out. Rule `system`.
   */
  disputeOf(
    context: CallContext,
    disputeIds: readonly string[],
  ): Promise<Result<readonly Dispute[], AccessDenied | { readonly code: 'validation.failed' }>>;
}

/** Nest token of the {@link PaymentsFacade}, provided and exported by `PaymentsModule`. */
export const PAYMENTS_FACADE = Symbol('PAYMENTS_FACADE');
