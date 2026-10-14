import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CartState } from '../../domain/cart';

/**
 * The store of carts and their lines (cart.carts, cart.cart_lines). Every method runs in the open
 * unit of the use case, through the Market-scoped client.
 */
export interface CartRepository {
  /** The account's active cart with its lines, or null. */
  findActiveByAccount(market: MarketContext, accountId: Id<'Account'>): Promise<CartState | null>;

  /** The cart of a guest token hash (hex), merged ones included, or null. */
  findByGuestHash(market: MarketContext, tokenHash: string): Promise<CartState | null>;

  /** Inserts a new cart with its lines. `duplicate`: the owner already has one (a lost race). */
  insert(market: MarketContext, cart: CartState): Promise<'inserted' | 'duplicate'>;

  /**
   * Writes the cart under the version it was read at and raises the version: the row first (the
   * version check), then the lines (removed ones deleted, changed ones written). `stale` writes
   * nothing: the cart changed since it was read, or the new owner already has an active cart.
   */
  save(market: MarketContext, cart: CartState): Promise<'saved' | 'stale'>;

  /**
   * The purge (cart design 12): selects the ids of up to `limit` carts ordered by
   * `last_changed_at` whose retention has ended (a guest or MERGED cart last changed at or before
   * `guestBefore`, an account cart at or before `accountBefore`), then deletes those ids with the
   * same condition repeated, so a cart changed in between stays. The lines go by the cascade.
   * Answers how many carts were deleted.
   */
  purgeInactive(
    market: MarketContext,
    guestBefore: Temporal.Instant,
    accountBefore: Temporal.Instant,
    limit: number,
  ): Promise<number>;
}

export const CART_REPOSITORY = Symbol('CART_REPOSITORY');
