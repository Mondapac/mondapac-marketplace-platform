import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';

// What the payout run asks of other modules, as this module needs it. The adapters in
// infrastructure bind these to the `sellers` and `payments` facades; every answer that is not a
// clear one is `'unavailable'` and the caller retries later, never decides on it.

/** A seller's operating zone as the run reads it. */
export interface SellerZone {
  readonly zone: string;
  /** The draft's zone, not yet carried by an approved revision: never used to pay on. */
  readonly provisional: boolean;
}

/** `sellers`: where the seller is, and whether the seller may sell (so be paid) at all. */
export interface SellerPayoutAccess {
  /** A seller with no zone is absent from the map. */
  zones(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, SellerZone> | 'unavailable'>;

  /** `sellingEligibility` of the system actor; anything not a clear yes is false. */
  eligible(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, boolean> | 'unavailable'>;
}

export const SELLER_PAYOUT_ACCESS = Symbol('COMMISSION_PAYOUTS_SELLER_PAYOUT_ACCESS');

/**
 * The checks of design 4.6 whose source does not exist yet: the seller owner's second factor and
 * the business-identifier re-check. No facade answers them today, so the bound adapter says
 * `ok` and this is an open item (see the pull request). When a facade exists the adapter answers
 * `second-factor-required` and the run holds the payout with that block reason.
 */
export interface PayoutPrerequisites {
  check(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<'ok' | 'second-factor-required' | 'unavailable'>;
}

export const PAYOUT_PREREQUISITES = Symbol('COMMISSION_PAYOUTS_PAYOUT_PREREQUISITES');

export type TransferRefusal = string;

export type InstructAnswer =
  | { readonly kind: 'accepted'; readonly transferExecutionId: string }
  | { readonly kind: 'refused'; readonly code: TransferRefusal };

export type TransferStateName =
  'none' | 'reserved' | 'sending' | 'executed' | 'refused' | 'abandoned' | 'failed';

export interface TransferLookup {
  readonly instructionKey: string;
  readonly state: TransferStateName;
  readonly transferExecutionId: string | null;
}

export type AbandonAnswer =
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'still-abandoned' }
  | { readonly kind: 'already-sent'; readonly transferExecutionId: string }
  | { readonly kind: 'in-flight' };

/** `payments`: the money leaves the platform here, and only here. Rule `system` on each. */
export interface PaymentsPayouts {
  /** Whether Stripe can pay each seller now (stored state). A seller not in the map is not ready. */
  readiness(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, boolean> | 'unavailable'>;

  /** At most once per key: `'unavailable'` means unknown, never "not sent". */
  instruct(
    context: CallContext,
    request: {
      readonly instructionKey: string;
      readonly sellerId: Id<'Seller'>;
      readonly amountMinor: bigint;
      readonly currency: string;
      readonly reference: string;
    },
  ): Promise<InstructAnswer | 'unavailable'>;

  lookup(
    context: CallContext,
    instructionKeys: readonly string[],
  ): Promise<readonly TransferLookup[] | 'unavailable'>;

  abandon(context: CallContext, instructionKey: string): Promise<AbandonAnswer | 'unavailable'>;
}

export const PAYMENTS_PAYOUTS = Symbol('COMMISSION_PAYOUTS_PAYMENTS_PAYOUTS');

/** The Market's limits on one transfer, for the admin's view (Market config of payments). */
export interface TransferLimitsView {
  readonly maxTransferMinor: bigint;
  readonly dailyAlertMinor: bigint;
  readonly currency: string;
  /** How long a send may be in flight at payments; commission-payouts' timeout is a multiple of it. */
  readonly sendLeaseSeconds: number;
}

export interface PayoutPolicy {
  /** Null when the Market has no payments config. */
  limits(market: MarketContext): TransferLimitsView | null;
  /** The Market's IANA zone, for "today" in the admin's daily total. */
  marketTimeZone(market: MarketContext): string;
}

export const PAYOUT_POLICY = Symbol('COMMISSION_PAYOUTS_PAYOUT_POLICY');
