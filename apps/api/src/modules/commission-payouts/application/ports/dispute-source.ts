import type { CallContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { DisputeStatus } from '../../domain/dispute';

/** A dispute as payments stores it (its facade's `Dispute`), decoded for this module. */
export interface ProviderDispute {
  readonly disputeId: string;
  readonly orderId: string;
  readonly providerDisputeId: string;
  readonly paymentIntentRef: string;
  readonly amount: Money;
  readonly status: DisputeStatus;
  readonly reason: string;
  readonly inquiry: boolean;
  readonly closed: boolean;
  readonly evidenceDueBy: Temporal.Instant | null;
  readonly fundsWithdrawn: boolean;
  readonly fundsWithdrawnAt: Temporal.Instant | null;
  readonly fundsReinstated: boolean;
  readonly fundsReinstatedAt: Temporal.Instant | null;
  readonly outcome: 'won' | 'lost' | null;
  readonly openedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * Where the dispute states come from: payments' `disputeOf`, read as the system actor. `null` =
 * payments does not know the dispute; `unavailable` = the read failed (retry). Late-bound by the
 * binding module, because payments reaches this module through ordering.
 */
export interface DisputeSource {
  read(context: CallContext, disputeId: string): Promise<ProviderDispute | null | 'unavailable'>;
}

export const DISPUTE_SOURCE = Symbol('COMMISSION_PAYOUTS_DISPUTE_SOURCE');

/** What ordering says of an order's own PaymentIntent. */
export type OrderPaymentAnswer =
  { readonly known: false } | { readonly known: true; readonly paymentIntentId: string | null };

export interface OrderPaymentLookup {
  paymentIntentOf(
    context: CallContext,
    orderId: string,
  ): Promise<OrderPaymentAnswer | 'unavailable'>;
}

export const ORDER_PAYMENT_LOOKUP = Symbol('COMMISSION_PAYOUTS_ORDER_PAYMENT_LOOKUP');
