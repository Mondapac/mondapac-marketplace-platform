import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Which Variants of these Offers are published sell units now (catalog's `offerSellUnits`), so a
 * price on a Variant that exists only in a draft is never shown. An absent Offer has none.
 * `null` when the check failed: the caller fails closed.
 */
export interface PublishedVariants {
  published(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, ReadonlySet<Id<'Variant'>>> | null>;
}

export const PUBLISHED_VARIANTS = Symbol('PUBLISHED_VARIANTS');
