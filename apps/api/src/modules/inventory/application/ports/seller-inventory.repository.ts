import type { Id, MarketContext } from '@mondapac/shared-kernel';
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

  /** The seller's inventory with its sources in priority order, or null when it has none. */
  findBySeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerInventory | null>;

  /**
   * Writes the changes of a loaded inventory (`inventory.changes`) and raises its version, only
   * if the stored version is still `inventory.persistedVersion`: otherwise nothing is written
   * and the answer is `stale` (D 2.3: another edit in between). A reorder writes in two passes
   * inside the one unit (T2): each moved source to `n + position`, then to `position`.
   */
  save(market: MarketContext, inventory: SellerInventory): Promise<'saved' | 'stale'>;
}

export const SELLER_INVENTORY_REPOSITORY = Symbol('SELLER_INVENTORY_REPOSITORY');
