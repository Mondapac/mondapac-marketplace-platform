import type { MarketContext } from '@mondapac/shared-kernel';
import type { SellerInventory } from '../../domain/seller-inventory';

/**
 * The store of seller inventories and their sources (inventory data design 3.2, 3.3). Every
 * method runs in the open unit of the use case.
 */
export interface SellerInventoryRepository {
  /**
   * Inserts the inventory and its sources. Answers false and writes nothing when the seller
   * already has an inventory in the Market (the unique key decides a creation race, data design
   * 3.2), so a repeated or concurrent creation converges.
   */
  add(market: MarketContext, inventory: SellerInventory): Promise<boolean>;
}

export const SELLER_INVENTORY_REPOSITORY = Symbol('SELLER_INVENTORY_REPOSITORY');
