import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Payout, PayoutItem, PayoutState } from '../../domain/payout';

/** A payout with the seller orders it takes. */
export interface PayoutWithItems {
  readonly payout: Payout;
  readonly items: readonly PayoutItem[];
}

/** Newest first; the cursor is the last row of the previous page. */
export interface PayoutPage {
  readonly limit: number;
  readonly after: { readonly createdAt: Temporal.Instant; readonly id: Id<'Payout'> } | null;
}

/** What a seller's payouts already hold, for working out the next one. */
export interface SellerPayoutPosition {
  /** Seller orders in an item that has not ended without paying, with what that item takes. */
  readonly itemAmounts: ReadonlyMap<Id<'SellerOrder'>, bigint>;
  /** Of those, the amounts in payouts that count as paid out (instructing, instructed, paid, netted). */
  readonly takenAmounts: ReadonlyMap<Id<'SellerOrder'>, bigint>;
  /** The sum of `netted` over the payouts that count as paid out: receivable the platform took back. */
  readonly nettedTotal: bigint;
  /** Whether the seller has ever been paid (a PAID payout): the first payout waits for an admin. */
  readonly hasPaid: boolean;
}

/**
 * The payouts of one Market (`commission_payouts.payouts` and `payout_items`). The database holds
 * the rules (a guard trigger on the transitions, one live payout per seller, items add up); the
 * methods here only read and make the writes the application role is granted.
 */
export interface PayoutRepository {
  /** Inserts the payout with its items in the open unit. */
  insert(market: MarketContext, payout: Payout, items: readonly PayoutItem[]): Promise<void>;

  find(market: MarketContext, id: Id<'Payout'>): Promise<Payout | null>;

  findWithItems(market: MarketContext, id: Id<'Payout'>): Promise<PayoutWithItems | null>;

  /** The payout payments' transfer id was written to. */
  findByTransferExecution(
    market: MarketContext,
    transferExecutionId: string,
  ): Promise<Payout | null>;

  /** The seller's live payout (pending, awaiting approval, approved or instructing), if any. */
  findLive(market: MarketContext, sellerId: Id<'Seller'>): Promise<Payout | null>;

  /**
   * Writes the change from `before` to `after` if the stored row is still `before` (state and
   * version): the state, the approval, the transfer id, the outcome and the clocks. False when it
   * moved meanwhile. The database refuses a transition the state machine does not have.
   */
  change(market: MarketContext, before: Payout, after: Payout): Promise<boolean>;

  position(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerPayoutPosition>;

  /** Payouts in these states, oldest change first. */
  listByState(
    market: MarketContext,
    states: readonly PayoutState[],
    limit: number,
  ): Promise<readonly Payout[]>;

  /** The Market's payouts newest first, all or one state. */
  list(
    market: MarketContext,
    filter: { readonly state: PayoutState | null },
    page: PayoutPage,
  ): Promise<readonly Payout[]>;

  /** One seller's payouts newest first, without the `hidden` states. */
  listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    hidden: readonly PayoutState[],
    page: PayoutPage,
  ): Promise<readonly Payout[]>;

  /** The sum of `transfer` of payouts that went to payments since `since` (instructed or paid). */
  sumTransferredSince(market: MarketContext, since: Temporal.Instant): Promise<bigint>;
}

export const PAYOUT_REPOSITORY = Symbol('PAYOUT_REPOSITORY');
