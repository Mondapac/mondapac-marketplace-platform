import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CartState } from '../../domain/cart';

/** An account cart that has lines and has been idle (personalization 1c). Ids and counts only. */
export interface IdleAccountCart {
  readonly cartId: Id<'Cart'>;
  readonly accountId: Id<'Account'>;
  readonly lastChangedAt: Temporal.Instant;
  readonly lineCount: number;
}

/** Where a page of idle carts starts: after this cart in `(last_changed_at, id)` order. */
export interface IdleCartCursor {
  readonly lastChangedAt: Temporal.Instant;
  readonly cartId: Id<'Cart'>;
}

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
   * version check, and the order mark cleared), then the lines (removed ones deleted, changed ones
   * written). `stale` writes
   * nothing: the cart changed since it was read, or the new owner already has an active cart.
   */
  save(market: MarketContext, cart: CartState): Promise<'saved' | 'stale'>;

  /**
   * Marks the cart as left by a paid order at `at` (the instant the save just wrote as
   * `lastChangedAt`): until the next save clears the mark, it gets no cart reminder
   * (personalization 1c).
   */
  markOrdered(market: MarketContext, cartId: Id<'Cart'>, at: Temporal.Instant): Promise<void>;

  /**
   * Up to `limit` ACTIVE account carts with at least one line, last changed after
   * `changedAfter` and at or before `changedAtOrBefore`, without the order mark, in
   * `(last_changed_at, id)` order after `after`. Guest and merged carts never appear.
   */
  idleAccountCarts(
    market: MarketContext,
    query: {
      readonly changedAfter: Temporal.Instant;
      readonly changedAtOrBefore: Temporal.Instant;
      readonly after: IdleCartCursor | null;
      readonly limit: number;
      /** Only these accounts' carts, when given. */
      readonly accountIds?: readonly Id<'Account'>[];
    },
  ): Promise<readonly IdleAccountCart[]>;

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
