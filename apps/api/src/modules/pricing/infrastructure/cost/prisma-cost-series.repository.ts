import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type {
  AddCostSeriesOutcome,
  CostSeriesRepository,
} from '../../application/ports/cost-series.repository';
import { assertSerializableUnit } from '../../application/serializable-unit';
import { restoreCostAmount, revealCostMinor } from '../../domain/cost/cost-amount';
import {
  CostSeries,
  type CostRecord,
  type CostRetireCause,
  type CostSeriesState,
} from '../../domain/cost/cost-series';

const AGGREGATE_TYPE = 'cost-series';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * Only the latest record of a series is read (the current Cost; pricing-data 3.7, 6): the one with
 * the highest series version, through `cost_records_market_id_cost_series_id_series_version_key`.
 * Never by `submitted_at`: two writes can share an instant.
 */
const LATEST_RECORD = {
  records: { orderBy: { seriesVersion: 'desc' as const }, take: 1 },
};

interface RecordRow {
  readonly id: string;
  readonly kind: string;
  readonly amountMinor: bigint | null;
  readonly currency: string;
  readonly submittedAt: Date;
  readonly submittedByAccountId: string;
}

interface SeriesRow {
  readonly id: string;
  readonly marketId: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly currency: string;
  readonly retiredAt: Date | null;
  readonly retireCause: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly records: readonly RecordRow[];
}

function recordFromRow(row: RecordRow): CostRecord {
  if (row.kind !== 'amount' && row.kind !== 'cleared') {
    throw new Error('cost record: unknown stored kind');
  }
  return {
    id: row.id as Id<'CostRecord'>,
    amount:
      row.kind === 'cleared' || row.amountMinor === null
        ? null
        : restoreCostAmount(row.amountMinor, row.currency),
    submittedAt: toInstant(row.submittedAt),
    submittedBy: row.submittedByAccountId as Id<'Account'>,
  };
}

function seriesFromRow(row: SeriesRow): CostSeries {
  const latest = row.records[0];
  return CostSeries.restore({
    id: row.id as Id<'CostSeries'>,
    marketId: row.marketId as MarketId,
    offerId: row.offerId as Id<'Offer'>,
    variantId: row.variantId as Id<'Variant'>,
    productId: row.productId as Id<'Product'>,
    sellerId: row.sellerId as Id<'Seller'>,
    currency: row.currency,
    retiredAt: row.retiredAt === null ? null : toInstant(row.retiredAt),
    retireCause: row.retireCause as CostRetireCause | null,
    version: row.version,
    createdAt: toInstant(row.createdAt),
    latest: latest === undefined ? null : recordFromRow(latest),
  });
}

/**
 * The Cost store (pricing-data 3.7; design 6.5). The only file that references the
 * `PricingCost*` models (`pnpm boundaries`, H-D1). Reads take the latest record per series only,
 * through the unique (series, version) index. Logs nothing.
 */
export class PrismaCostSeriesRepository implements CostSeriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(
    market: MarketContext,
    key: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
  ): Promise<CostSeries | null> {
    const row = await this.prisma.tx(market).pricingCostSeries.findFirst({
      where: { marketId: market.marketId, offerId: key.offerId, variantId: key.variantId },
      include: LATEST_RECORD,
    });
    return row === null ? null : seriesFromRow(row);
  }

  async findByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<readonly CostSeries[]> {
    const rows = await this.prisma.tx(market).pricingCostSeries.findMany({
      where: { marketId: market.marketId, offerId },
      include: LATEST_RECORD,
      orderBy: { id: 'asc' },
    });
    return rows.map(seriesFromRow);
  }

  async add(market: MarketContext, series: CostSeries): Promise<AddCostSeriesOutcome> {
    // Fail closed outside a serializable unit (pricing-data 5.1; Hassan M1): before any read.
    assertSerializableUnit('CostSeriesRepository.add');
    const state = series.state;
    if (series.storedState !== null) throw new Error('add: the series is stored; use save');
    if (state.marketId !== market.marketId) throw new Error('add: the series is of another Market');
    if (state.appended === null)
      throw new Error('add: a new series is stored with its first record');
    const tx = this.prisma.tx(market);

    // Both tombstones by primary key, read in the creating unit (pricing-data 3.6, 5.1).
    const retiredOffer = await tx.pricingRetiredOffer.findFirst({
      where: { marketId: market.marketId, offerId: state.offerId },
      select: { offerId: true },
    });
    const retiredVariant = await tx.pricingRetiredVariant.findFirst({
      where: {
        marketId: market.marketId,
        productId: state.productId,
        variantId: state.variantId,
      },
      select: { variantId: true },
    });
    if (retiredOffer !== null || retiredVariant !== null) return 'key-retired';

    const { count } = await tx.pricingCostSeries.createMany({
      data: [
        {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: state.offerId,
          variantId: state.variantId,
          productId: state.productId,
          sellerId: state.sellerId,
          currency: state.currency,
          retiredAt: null,
          retireCause: null,
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    // Zero rows: the key (or the id) is taken, a lost creation race (P 10).
    if (count !== 1) throw new StaleAggregateError(AGGREGATE_TYPE, state.id);
    await this.#insertRecord(market, state, state.appended);
    series.markStored();
    return 'added';
  }

  async save(market: MarketContext, series: CostSeries): Promise<void> {
    const stored = series.storedState;
    if (stored === null) throw new Error('save: the series was never stored; use add');
    const next = series.state;
    if (next.marketId !== market.marketId) throw new Error('save: the series is of another Market');
    if (next.version === stored.version) return;
    if (next.appended === null) throw new Error('save: a version raise without a record');
    const tx = this.prisma.tx(market);
    // The version first (P7): a concurrent writer of the series waits on that row, then is stale.
    const { count } = await tx.pricingCostSeries.updateMany({
      where: { marketId: market.marketId, id: next.id, version: stored.version },
      data: { version: next.version },
    });
    if (count !== 1) throw new StaleAggregateError(AGGREGATE_TYPE, next.id);
    await this.#insertRecord(market, next, next.appended);
    series.markStored();
  }

  async #insertRecord(
    market: MarketContext,
    series: CostSeriesState,
    record: CostRecord,
  ): Promise<void> {
    const value = record.amount === null ? null : revealCostMinor(record.amount);
    if (value !== null && value.currency !== series.currency) {
      throw new Error('cost record: the amount is not in the series currency');
    }
    await this.prisma.tx(market).pricingCostRecord.create({
      data: {
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        costSeriesId: series.id,
        seriesVersion: series.version,
        kind: value === null ? 'cleared' : 'amount',
        amountMinor: value === null ? null : value.amount,
        currency: series.currency,
        submittedAt: toDate(record.submittedAt),
        submittedByAccountId: record.submittedBy,
      },
      select: { id: true },
    });
  }
}
