import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellUnitLabelsReader } from '../application/ports/sell-unit-labels.reader';
import {
  sellUnitKey,
  type SellUnitKey,
  type SellUnitLabel,
  type SellUnitLabelsMap,
} from '../contracts/catalog.facade';

/** The text for `locale`, else the first locale in code order, else undefined. */
function pick(texts: Readonly<Record<string, string>>, locale: string): string | undefined {
  if (typeof texts[locale] === 'string') return texts[locale];
  const first = Object.keys(texts).sort()[0];
  return first === undefined ? undefined : texts[first];
}

/**
 * {@link SellUnitLabelsReader}: the Offers by `(market_id, id)`, their products' PUBLISHED
 * revision, then that revision's texts and Variant labels. Four statements, no join, every one
 * scoped by `market_id`. A product without a published revision has no name, so its keys are
 * absent; the Variant label comes from the same published revision only.
 */
export class PrismaSellUnitLabelsReader implements SellUnitLabelsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    keys: readonly SellUnitKey[],
    locale: string,
  ): Promise<SellUnitLabelsMap> {
    const result = new Map<string, SellUnitLabel>();
    if (keys.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...new Set(keys.map((k) => k.offerId))] } },
      select: { id: true, productId: true },
    });
    if (offers.length === 0) return result;
    const products = await tx.catalogProduct.findMany({
      where: {
        marketId: market.marketId,
        id: { in: [...new Set(offers.map((o) => o.productId))] },
        publishedRevisionId: { not: null },
      },
      select: { id: true, publishedRevisionId: true },
    });
    const revisionOf = new Map<string, string>();
    for (const row of products) {
      if (row.publishedRevisionId !== null) revisionOf.set(row.id, row.publishedRevisionId);
    }
    const revisionIds = [...new Set(revisionOf.values())];
    if (revisionIds.length === 0) return result;
    const texts = await tx.catalogProductRevisionText.findMany({
      where: { marketId: market.marketId, revisionId: { in: revisionIds } },
      select: { revisionId: true, locale: true, name: true },
    });
    const namesOf = new Map<string, Record<string, string>>();
    for (const text of texts) {
      const byLocale = namesOf.get(text.revisionId) ?? {};
      byLocale[text.locale] = text.name;
      namesOf.set(text.revisionId, byLocale);
    }
    const variants = await tx.catalogProductRevisionVariant.findMany({
      where: {
        marketId: market.marketId,
        revisionId: { in: revisionIds },
        variantId: { in: [...new Set(keys.map((k) => k.variantId))] },
      },
      select: { revisionId: true, variantId: true, labels: true },
    });
    const labelsOf = new Map<string, Record<string, string>>();
    for (const row of variants) {
      if (row.labels !== null && typeof row.labels === 'object' && !Array.isArray(row.labels)) {
        labelsOf.set(`${row.revisionId}:${row.variantId}`, row.labels as Record<string, string>);
      }
    }
    const productOf = new Map(offers.map((o) => [o.id as Id<'Offer'>, o.productId] as const));
    for (const key of keys) {
      const productId = productOf.get(key.offerId);
      const revisionId = productId === undefined ? undefined : revisionOf.get(productId);
      if (revisionId === undefined) continue;
      const names = namesOf.get(revisionId);
      const productName = names === undefined ? undefined : pick(names, locale);
      if (productName === undefined) continue;
      const labels = labelsOf.get(`${revisionId}:${key.variantId}`);
      const label = labels === undefined ? undefined : pick(labels, locale);
      result.set(sellUnitKey(key), { productName, variantLabel: label ?? null });
    }
    return result;
  }
}
