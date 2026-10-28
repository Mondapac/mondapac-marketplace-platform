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
  /**
   * The charge's PaymentIntent (pi_...), from Stripe. The order id comes from metadata ordering
   * wrote on it; a consumer checks that this is the order's own PaymentIntent before acting.
   */
  readonly paymentIntentRef: string;
  /** The disputed amount. */
  readonly amount: Money;
  readonly status: DisputeStatus;
  /** Stripe's reason code (`other` for one payments does not know); never the buyer's text. */
  readonly reason: string;
  /** An inquiry: no money is withdrawn while it stays one. */
  readonly inquiry: boolean;
  /**
   * Stripe will not change it any more: `won`, `lost`, `warning_closed` (an inquiry that never
   * became a chargeback) or `prevented`. The only signal to release a hold on.
   */
  readonly closed: boolean;
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

// How a consumer uses disputes (package 8b; payments.md 3.3): `payments.dispute-changed.v1` is a
// trigger only; read `disputeOf` and act on the state it returns, never on the event's version
// (deliveries can arrive out of order or after a later change). Key a hold on `disputeId` and a
// ledger row on (`disputeId`, withdrawn) and (`disputeId`, reinstated): the flags only move from
// false to true. `outcome: 'lost'` with `fundsReinstated: true` cannot be told apart from a second
// withdrawal, so treat it as a case for an admin, never net it to zero. The order id is not checked
// against ordering here: check `paymentIntentRef` against the order's own PaymentIntent, and park
// and raise an unknown order or a mismatch, never act on it or drop it.

/** Why `instructTransfer` refused: definite, nothing was sent (design 4.7); mapped as given. */
export type TransferRefusalCode =
  | 'validation.failed'
  | 'idempotency.key-reused'
  | 'payments.transfer.currency-mismatch'
  | 'payments.transfer.amount-out-of-range'
  | 'payments.transfer.account-not-ready'
  | 'payments.transfer.cooling-off'
  | 'payments.transfer.account-under-review'
  | 'payments.transfer.insufficient-platform-balance'
  | 'payments.transfer.provider-refused';

/** What commission-payouts asks for: one transfer to one seller, once. */
export interface InstructTransferRequest {
  /** Commission-payouts' key (1 to 128 of A-Z a-z 0-9 : _ -): unique per Market, never reused. */
  readonly instructionKey: string;
  readonly sellerId: string;
  /** In the Market's currency, above zero and not above the Market's ceiling. */
  readonly amount: Money;
  /** Commission-payouts' payout id: the transfer group and metadata at Stripe. */
  readonly reference: string;
}

export type InstructTransferAnswer =
  /** Stripe created the transfer (now, or earlier under the same key). */
  | { readonly kind: 'accepted'; readonly transferExecutionId: string }
  /** Definite: nothing was sent. */
  | { readonly kind: 'refused'; readonly code: TransferRefusalCode };

/** The states of a stored transfer; `none` is a key with no row. */
export type TransferState =
  'none' | 'reserved' | 'sending' | 'executed' | 'refused' | 'abandoned' | 'failed';

/** One key's stored transfer. */
export interface TransferByKeyResult {
  readonly instructionKey: string;
  readonly state: TransferState;
  readonly transferExecutionId: string | null;
  /** Null for `none` and for a tombstone. */
  readonly amount: Money | null;
  /** What Stripe reported as reversed; null for `none`. */
  readonly reversed: Money | null;
}

export type AbandonTransferAnswer =
  | { readonly kind: 'abandoned'; readonly abandonedAt: Temporal.Instant }
  | { readonly kind: 'still-abandoned' }
  | { readonly kind: 'already-sent'; readonly transferExecutionId: string }
  | { readonly kind: 'in-flight' };

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

  /**
   * Sends one transfer from the platform balance to the seller's connected account, at most once
   * (package 6c; design 4.7 P-a). `payments.unavailable`: nothing is known to have been sent, or
   * the send's answer is unknown (it stays `sending` and is never repeated: ask `transferByKey`,
   * then `abandonTransfer` after your own timeout). Rule `system`.
   */
  instructTransfer(
    context: CallContext,
    request: InstructTransferRequest,
  ): Promise<
    Result<InstructTransferAnswer, AccessDenied | { readonly code: 'payments.unavailable' }>
  >;

  /** The stored state of up to 100 transfers, in the order asked; no call to Stripe (P-c). Rule `system`. */
  transferByKey(
    context: CallContext,
    instructionKeys: readonly string[],
  ): Promise<
    Result<readonly TransferByKeyResult[], AccessDenied | { readonly code: 'validation.failed' }>
  >;

  /**
   * The fence for a key whose send never got an answer (P-d): `abandoned` is final, `still-abandoned`
   * is the quarantine pass finding nothing, `already-sent` means a transfer exists, `in-flight`
   * that the send's lease has not run out. Record `NOT_SENT` only on `abandoned` and
   * `still-abandoned`. Rule `system`.
   */
  abandonTransfer(
    context: CallContext,
    instructionKey: string,
  ): Promise<
    Result<
      AbandonTransferAnswer,
      | AccessDenied
      | { readonly code: 'validation.failed' }
      | { readonly code: 'payments.unavailable' }
    >
  >;

  /**
   * The stored disputes of one order of this Market, oldest first (an index on the order). Same
   * shape and rules as {@link PaymentsFacade.disputeOf}; an unknown order has none. Rule `system`.
   */
  disputesOfOrder(
    context: CallContext,
    orderId: string,
  ): Promise<Result<readonly Dispute[], AccessDenied | { readonly code: 'validation.failed' }>>;
}

/** Nest token of the {@link PaymentsFacade}, provided and exported by `PaymentsModule`. */
export const PAYMENTS_FACADE = Symbol('PAYMENTS_FACADE');
