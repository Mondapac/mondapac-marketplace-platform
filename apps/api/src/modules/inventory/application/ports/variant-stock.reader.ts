import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** A page of Variants, ascending by id; the caller pages on the last id. */
export interface OutOfStockVariantPage {
  readonly limit: number;
  readonly after: Id<'Variant'> | null;
}

/**
 * The platform-wide stock view of Variants (no seller filter): a read of the availability signals
 * and stock items of one Market, in a read-only unit.
 *
 * A Variant is out of stock everywhere when it has at least one live sell unit (a stock item that
 * is not retired) and no sell unit of it has a signal other than `out`. A Variant whose items are
 * all retired is not counted: nothing sells it, which is catalog's "No seller selling".
 */
export interface VariantStockReader {
  /** Up to `limit` Variant ids that are out of stock everywhere, ascending. */
  listOutOfStockEverywhere(
    market: MarketContext,
    page: OutOfStockVariantPage,
  ): Promise<readonly Id<'Variant'>[]>;

  /** How many Variants of the Market are out of stock everywhere. */
  countOutOfStockEverywhere(market: MarketContext): Promise<number>;
}

export const VARIANT_STOCK_READER = Symbol('VARIANT_STOCK_READER');
