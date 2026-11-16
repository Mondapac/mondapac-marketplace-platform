import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { RedemptionRecord, ReleaseReason } from '../../domain/redemption';

/** What a redemption or its release moves on one promotion's usage counters. */
export interface UsageDelta {
  readonly promotionId: Id<'Promotion'>;
  /** +1 for a redemption, -1 for a release. */
  readonly uses: number;
  readonly spent: bigint;
  readonly sellerShare: bigint;
  readonly platformShare: bigint;
}

/**
 * What orders took from the promotions (`promotions.redemptions`), and the state that moves with
 * it: the usage counters (`promotion_usage`) and the single-use codes (`promotion_batch_codes`).
 * Every method runs in the caller's unit.
 */
export interface RedemptionRepository {
  /** Every redemption of one order (any status). */
  forOrder(market: MarketContext, orderId: Id<'Order'>): Promise<readonly RedemptionRecord[]>;
  insertMany(market: MarketContext, records: readonly RedemptionRecord[]): Promise<void>;
  /** RESERVED rows of the order become CONFIRMED; answers how many moved. */
  confirm(market: MarketContext, orderId: Id<'Order'>, at: Temporal.Instant): Promise<number>;
  /**
   * The order's rows that hold (RESERVED, and CONFIRMED when `includeConfirmed`) become RELEASED;
   * answers the rows as they were before the release, so the caller gives back what they took.
   */
  release(
    market: MarketContext,
    orderId: Id<'Order'>,
    reason: ReleaseReason,
    at: Temporal.Instant,
    includeConfirmed: boolean,
  ): Promise<readonly RedemptionRecord[]>;
  /**
   * Takes the row locks of these promotions' usage counters until the unit ends, in id order (so
   * two redemptions never wait on each other in a cycle). A promotion gets its usage row when it is
   * created; one that lacks it (a row written outside the repository) gets a zero row here, since
   * the quote already applied that promotion and its redemption must be counted.
   */
  lockUsage(
    market: MarketContext,
    promotionIds: readonly Id<'Promotion'>[],
    at: Temporal.Instant,
  ): Promise<void>;
  /**
   * Takes the row lock of the Market's promotions switch until the unit ends: the first-order
   * budget is one per Market and month, so its spenders queue on this row. False when the Market
   * has no switch row (promotions were never on).
   */
  lockMarket(market: MarketContext): Promise<boolean>;
  /** Adds the deltas to the counters (the core CHECK refuses any counter below zero). */
  addUsage(
    market: MarketContext,
    deltas: readonly UsageDelta[],
    at: Temporal.Instant,
  ): Promise<void>;
  /** Live (not RELEASED) redemptions of each promotion by one customer. */
  customerUses(
    market: MarketContext,
    customerAccountId: Id<'Account'>,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, number>>;
  /** Live units sold of each promotion (flash sales); a promotion with none answers 0. */
  unitsSold(
    market: MarketContext,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, number>>;
  /** The first-order money held (not RELEASED) in one month (`YYYY-MM`). */
  firstOrderSpent(market: MarketContext, budgetMonth: string): Promise<bigint>;
  /**
   * Claims an unused single-use code for an order: true when this call set it (or the order already
   * holds it), false when another order holds it.
   */
  claimCode(
    market: MarketContext,
    codeHash: string,
    orderId: Id<'Order'>,
    at: Temporal.Instant,
  ): Promise<boolean>;
  /** Gives a code back, only if this order holds it. */
  unclaimCode(market: MarketContext, codeHash: string, orderId: Id<'Order'>): Promise<void>;
  /** RESERVED rows older than `before`, oldest first (the order ids, distinct). */
  staleReservations(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<readonly Id<'Order'>[]>;
}

export const REDEMPTION_REPOSITORY = Symbol('PROMOTIONS_REDEMPTION_REPOSITORY');
