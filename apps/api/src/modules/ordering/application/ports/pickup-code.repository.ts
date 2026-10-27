import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PickupCodeRecord, PickupStatus } from '../../domain/pickup-code';

/**
 * The store of pickup codes (`ordering.pickup_codes`): one row per pickup seller order. Every
 * method runs in the open unit of the use case, through the Market-scoped client.
 */
export interface PickupCodeRepository {
  find(market: MarketContext, sellerOrderId: Id<'SellerOrder'>): Promise<PickupCodeRecord | null>;

  /** The codes of some seller orders; an order without one is absent. */
  findMany(
    market: MarketContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<ReadonlyMap<Id<'SellerOrder'>, PickupCodeRecord>>;

  /** Stores the first code of a seller order; false (nothing written) when it already has one. */
  insert(market: MarketContext, record: PickupCodeRecord): Promise<boolean>;

  /**
   * Replaces the code of a seller order that has one: the new hash and sealed copy, the failure
   * count back to zero and no lock. False when the seller order has no code.
   */
  replace(market: MarketContext, record: PickupCodeRecord): Promise<boolean>;

  /**
   * Counts one more wrong code, atomically, and locks the order at the limit. Answers the status
   * after the count; an already locked order is not counted again. Null when there is no code.
   */
  registerFailure(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    now: Temporal.Instant,
  ): Promise<PickupStatus | null>;
}

export const PICKUP_CODE_REPOSITORY = Symbol('PICKUP_CODE_REPOSITORY');
