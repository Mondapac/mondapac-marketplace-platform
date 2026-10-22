import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * Read-only view of the platform categories that the published claim policies of one Market name
 * with a basis that asks for a certification (anything but `NOT_APPLICABLE`), for every type,
 * active or inactive. Sorted, no duplicates. A failure rejects: nothing here answers a guess.
 */
export interface CertifiedCategoriesReader {
  categoryIds(market: MarketContext): Promise<readonly Id<'Category'>[]>;
}
