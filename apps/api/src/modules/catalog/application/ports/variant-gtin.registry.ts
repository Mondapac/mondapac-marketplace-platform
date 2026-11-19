import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * Another product that already carries a GTIN (variants V4, plan decision 5). Only what a
 * duplicate notice may say: the scope, and for a PLATFORM product its public code. A SELLER
 * product is never named (no code, id or seller) so a seller cannot learn what another sells.
 */
export interface GtinDuplicate {
  /** The 14-digit GTIN that matched. */
  readonly gtin: string;
  readonly scope: 'PLATFORM' | 'SELLER';
  /** The public product code, set only for a PLATFORM product. */
  readonly platformProductCode: string | null;
}

/**
 * Where a GTIN is already used in the Market: the not-retired variants of the published revision
 * of every published product other than `exceptProductId`. Runs in a read-only unit.
 */
export interface VariantGtinRegistry {
  duplicatesOf(
    market: MarketContext,
    exceptProductId: Id<'Product'>,
    gtins: readonly string[],
  ): Promise<readonly GtinDuplicate[]>;
}

export const VARIANT_GTIN_REGISTRY = Symbol('VARIANT_GTIN_REGISTRY');
