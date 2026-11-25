import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  MAX_RECHECKS_PER_WRITE,
  MAX_REFERENCE_PRICES,
  type FirstPriceCheck,
  type FirstPriceCheckStore,
  type PendingRecheck,
  type Recheck,
  type VariantKey,
  type VariantPriceReader,
  type VariantRegularPrice,
} from '../application/ports/first-price-reference';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * R4 persistence (ADR-0051): pricing's own prices of a Variant and the stored checks. Every
 * statement goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`; no
 * raw SQL.
 */
export class PrismaFirstPriceChecks implements VariantPriceReader, FirstPriceCheckStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One statement: the accepted or approved regular record whose period holds `now`, of each
   * series of (product, Variant) that is not retired (the series index `(market, product,
   * variant)`). A series has at most one such record (the no-overlap EXCLUDE). Oldest series first.
   */
  async regularPricesInForce(
    market: MarketContext,
    key: VariantKey,
    now: Temporal.Instant,
  ): Promise<readonly VariantRegularPrice[]> {
    const at = toDate(now);
    const rows = await this.prisma.tx(market).pricingRegularPriceRecord.findMany({
      where: {
        marketId: market.marketId,
        status: { in: ['accepted', 'approved'] },
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        series: {
          marketId: market.marketId,
          productId: key.productId,
          variantId: key.variantId,
          retiredAt: null,
        },
      },
      orderBy: [{ seriesId: 'asc' }],
      take: MAX_REFERENCE_PRICES,
      select: {
        amountMinor: true,
        series: { select: { id: true, offerId: true, sellerId: true } },
      },
    });
    return rows.map((row) =>
      Object.freeze({
        seriesId: row.series.id as Id<'PriceSeries'>,
        offerId: row.series.offerId as Id<'Offer'>,
        sellerId: row.series.sellerId as Id<'Seller'>,
        amountMinor: row.amountMinor,
      }),
    );
  }

  async record(market: MarketContext, check: FirstPriceCheck): Promise<void> {
    await this.prisma.tx(market).pricingFirstPriceCheck.create({
      data: {
        recordId: check.recordId,
        marketId: market.marketId,
        tenantId: market.tenantId,
        seriesId: check.seriesId,
        offerId: check.offerId,
        productId: check.productId,
        variantId: check.variantId,
        sellerId: check.sellerId,
        outcome: check.outcome,
        referenceAmountMinor: check.referenceAmountMinor,
        referenceBusinesses: check.businesses,
        businessesNeeded: check.businessesNeeded,
        bandPercent: check.bandPercent,
        postReviewReason: check.postReviewReason,
        checkedAt: toDate(check.checkedAt),
      },
    });
  }

  /** The partial index of the migration: (market, product, variant, checked_at, record_id). */
  async pendingRechecks(
    market: MarketContext,
    key: VariantKey,
  ): Promise<readonly PendingRecheck[]> {
    const rows = await this.prisma.tx(market).pricingFirstPriceCheck.findMany({
      where: {
        marketId: market.marketId,
        productId: key.productId,
        variantId: key.variantId,
        recheckedAt: null,
        outcome: { in: ['no-reference', 'reference-unavailable'] },
      },
      orderBy: [{ checkedAt: 'asc' }, { recordId: 'asc' }],
      take: MAX_RECHECKS_PER_WRITE,
      select: { recordId: true, seriesId: true, offerId: true, sellerId: true, variantId: true },
    });
    return rows.map((row) =>
      Object.freeze({
        recordId: row.recordId as Id<'RegularPriceRecord'>,
        seriesId: row.seriesId as Id<'PriceSeries'>,
        offerId: row.offerId as Id<'Offer'>,
        sellerId: row.sellerId as Id<'Seller'>,
        variantId: row.variantId as Id<'Variant'>,
      }),
    );
  }

  /** Conditional on `rechecked_at IS NULL`, so two writes never re-check one row twice. */
  async markRechecked(market: MarketContext, recheck: Recheck): Promise<boolean> {
    const updated = await this.prisma.tx(market).pricingFirstPriceCheck.updateMany({
      where: { marketId: market.marketId, recordId: recheck.recordId, recheckedAt: null },
      data: {
        recheckedAt: toDate(recheck.at),
        recheckOutcome: recheck.outcome,
        recheckReferenceAmountMinor: recheck.referenceAmountMinor,
        recheckAmountMinor: recheck.amountMinor,
        // An earlier price outside the band is reviewed for that reason; within, it stays on the
        // list for its first reason (no reference when it went live).
        ...(recheck.outcome === 'outside' ? { postReviewReason: 'recheck-outside' } : {}),
      },
    });
    return updated.count === 1;
  }
}
