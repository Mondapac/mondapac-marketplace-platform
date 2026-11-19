import type { Id, IdGenerator, MarketContext, Temporal } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OfferSellUnitRefusal,
  OfferSellUnitRepository,
  StoredSellUnit,
} from '../application/ports/offer-sell-unit.repository';
import type { SellUnitState } from '../domain/offer-sell-unit';

const SKU_CONSTRAINTS: ReadonlySet<string> = new Set([
  'offer_sell_units_market_id_seller_id_variant_sku_key',
  'offer_sell_units_vs_offer_sku',
]);

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link OfferSellUnitRepository}: two statements to read (the variants of the product, then the
 * Offer's rows, no join), one upsert per changed variant to write. Every statement is scoped by
 * `market_id`.
 */
export class PrismaOfferSellUnitRepository implements OfferSellUnitRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async lockOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<void> {
    await this.prisma.tx(market).catalogOffer.updateMany({
      where: { marketId: market.marketId, id: offerId },
      data: { version: { increment: 0 } },
    });
  }

  async unitsOf(
    market: MarketContext,
    offerId: Id<'Offer'>,
    productId: Id<'Product'>,
  ): Promise<readonly (SellUnitState & { readonly variantNo: number })[]> {
    const tx = this.prisma.tx(market);
    const variants = await tx.catalogProductVariant.findMany({
      where: { marketId: market.marketId, productId, state: { in: ['proposed', 'published'] } },
      select: { id: true, variantNo: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (variants.length === 0) return [];
    const rows = await tx.catalogOfferSellUnit.findMany({
      where: { marketId: market.marketId, offerId },
      select: { variantId: true, variantSku: true, selling: true },
    });
    const byVariant = new Map(rows.map((row) => [row.variantId, row] as const));
    return variants.map((variant) => {
      const row = byVariant.get(variant.id);
      return {
        variantId: variant.id,
        variantNo: variant.variantNo,
        variantSku: row?.variantSku ?? null,
        selling: row?.selling ?? true,
      };
    });
  }

  async save(
    market: MarketContext,
    offer: {
      readonly id: Id<'Offer'>;
      readonly sellerId: Id<'Seller'>;
      readonly productId: Id<'Product'>;
    },
    states: readonly SellUnitState[],
    now: Temporal.Instant,
  ): Promise<
    | { readonly refusal: OfferSellUnitRefusal }
    | { readonly refusal: null; readonly stored: readonly StoredSellUnit[] }
  > {
    const tx = this.prisma.tx(market);
    const stored: StoredSellUnit[] = [];
    try {
      for (const state of states) {
        const existing = await tx.catalogOfferSellUnit.findFirst({
          where: { marketId: market.marketId, offerId: offer.id, variantId: state.variantId },
          select: { id: true, version: true },
        });
        if (existing === null) {
          const rowId = this.ids.next<'OfferSellUnit'>();
          stored.push({ variantId: state.variantId as Id<'Variant'>, rowId, version: 1 });
          await tx.catalogOfferSellUnit.create({
            data: {
              id: rowId,
              marketId: market.marketId,
              tenantId: market.tenantId,
              offerId: offer.id,
              sellerId: offer.sellerId,
              productId: offer.productId,
              variantId: state.variantId,
              variantSku: state.variantSku,
              selling: state.selling,
              version: 1,
              createdAt: toDate(now),
              updatedAt: toDate(now),
            },
          });
        } else {
          stored.push({
            variantId: state.variantId as Id<'Variant'>,
            rowId: existing.id as Id,
            version: existing.version + 1,
          });
          const updated = await tx.catalogOfferSellUnit.updateMany({
            where: {
              marketId: market.marketId,
              offerId: offer.id,
              variantId: state.variantId,
              version: existing.version,
            },
            data: {
              variantSku: state.variantSku,
              selling: state.selling,
              version: existing.version + 1,
              updatedAt: toDate(now),
            },
          });
          // A lost race on the row's version: the caller's unit ends and nothing commits.
          if (updated.count !== 1)
            throw new StaleAggregateError('catalog.offer_sell_units', stored.at(-1)!.rowId);
        }
      }
    } catch (error) {
      const violated = this.prisma.violatedConstraint(error);
      // Two first inserts of one row raced: the second starts again (the use case answers conflict.stale).
      if (violated === 'offer_sell_units_pkey') {
        throw new StaleAggregateError('catalog.offer_sell_units', offer.id);
      }
      if (violated !== null && SKU_CONSTRAINTS.has(violated)) return { refusal: 'offer.sku-taken' };
      throw error;
    }
    return { refusal: null, stored };
  }
}
