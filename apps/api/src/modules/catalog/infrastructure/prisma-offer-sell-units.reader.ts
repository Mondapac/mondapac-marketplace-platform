import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferSellUnits,
  OfferSellUnitsMap,
  OfferStatus,
  SellUnit,
  SellUnitState,
} from '../contracts/catalog.facade';
import type { OfferSellUnitsReader } from '../application/ports/offer-sell-units.reader';

/**
 * {@link OfferSellUnitsReader} (data design 6.1, query A1): the Offers by `(market_id, id)`, then
 * the non-retired variants of their products. Two statements, no join. A deleted Offer is present
 * with no sell units; an unknown id or an id of another Market is absent.
 */
export class PrismaOfferSellUnitsReader implements OfferSellUnitsReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<OfferSellUnitsMap> {
    const result = new Map<Id<'Offer'>, OfferSellUnits>();
    if (offerIds.length === 0) return result;
    const tx = this.prisma.tx(market);
    const offers = await tx.catalogOffer.findMany({
      where: { marketId: market.marketId, id: { in: [...offerIds] } },
      select: { id: true, sellerId: true, productId: true, status: true, listed: true },
    });
    const productIds = [
      ...new Set(offers.filter((offer) => offer.status !== 'deleted').map((o) => o.productId)),
    ];
    const variants =
      productIds.length === 0
        ? []
        : await tx.catalogProductVariant.findMany({
            where: {
              marketId: market.marketId,
              productId: { in: productIds },
              state: { in: ['proposed', 'published'] },
            },
            select: { id: true, productId: true, state: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
    const byProduct = new Map<string, SellUnit[]>();
    for (const variant of variants) {
      const list = byProduct.get(variant.productId) ?? [];
      list.push({ variantId: variant.id as Id<'Variant'>, state: variant.state as SellUnitState });
      byProduct.set(variant.productId, list);
    }
    for (const offer of offers) {
      result.set(offer.id as Id<'Offer'>, {
        sellerId: offer.sellerId as Id<'Seller'>,
        productId: offer.productId as Id<'Product'>,
        status: offer.status as OfferStatus,
        listed: offer.listed,
        sellUnits: offer.status === 'deleted' ? [] : (byProduct.get(offer.productId) ?? []),
      });
    }
    return result;
  }
}
