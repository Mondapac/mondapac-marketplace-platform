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
  /**
   * Inserts the rows of one order. Throws {@link RedemptionTakenError} when a row of the same order
   * and key exists (a concurrent redemption, or the head row a cancellation wrote).
   */
  insertMany(market: MarketContext, records: readonly RedemptionRecord[]): Promise<void>;
  /**
   * Writes the order's head row RELEASED when the order has none (a cancellation before the
   * redemption). Waits on, and then yields to, a redemption of the order still in progress.
   */
  markReleased(
    market: MarketContext,
    orderId: Id<'Order'>,
    id: string,
    reason: ReleaseReason,
    at: Temporal.Instant,
  ): Promise<void>;
  /** Live (not RELEASED) first-order redemptions of one customer, any order. */
  customerFirstOrders(market: MarketContext, customerAccountId: Id<'Account'>): Promise<number>;
  /**
   * RESERVED rows of the order become CONFIRMED, one row at a time in key order (the order
   * `release` takes them in, so a payment and a cancellation never wait in a cycle); answers how
   * many moved.
   */
  confirm(market: MarketContext, orderId: Id<'Order'>, at: Temporal.Instant): Promise<number>;
  /**
   * The order's rows that hold (RESERVED, and CONFIRMED when `includeConfirmed`) become RELEASED,
   * in key order; answers the rows that this call moved, so the caller gives back what they took.
   * A row confirmed meanwhile is still released (the status is checked again under its lock); a
   * row another call released is not answered.
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
  /** Orders with RESERVED rows older than `before`, by order id, after `after` when given. */
  staleReservations(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
    after: Id<'Order'> | null,
  ): Promise<readonly Id<'Order'>[]>;
  /**
   * One customer's discounts (any status, never the orders' head rows), newest reservation first
   * then id, after `after` when given (customers management phase 2b, item e).
   */
  forCustomer(
    market: MarketContext,
    customerAccountId: Id<'Account'>,
    limit: number,
    after: UsageCursor | null,
  ): Promise<readonly CustomerUsage[]>;
}

/** One discount an order of a customer took (a per-promotion row; never an order's head row). */
export interface CustomerUsage {
  readonly record: RedemptionRecord;
  /** The stored promotion's name; null for a settings-based offer (first order, free delivery). */
  readonly promotionName: string | null;
}

/** The keyset position of a customer's usage: its reservation instant and id. */
export interface UsageCursor {
  readonly reservedAt: Temporal.Instant;
  readonly id: string;
}

/** A row of the same order and key exists: another redemption or a cancellation came first. */
export class RedemptionTakenError extends Error {
  constructor() {
    super('promotions.redemptions: order already has rows');
    this.name = 'RedemptionTakenError';
  }
}

export const REDEMPTION_REPOSITORY = Symbol('PROMOTIONS_REDEMPTION_REPOSITORY');
