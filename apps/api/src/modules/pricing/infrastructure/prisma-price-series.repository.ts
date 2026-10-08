import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type {
  AddPriceSeriesOutcome,
  PriceSeriesKey,
  PriceSeriesRepository,
} from '../application/ports/price-series.repository';
import type { PriceAmount } from '../domain/price-amount';
import {
  PriceSeries,
  type PriceSeriesState,
  type RegularPriceRecord,
  type RegularRecordStatus,
  type RetireCause,
  type SupersedeCause,
} from '../domain/price-series';

const AGGREGATE_TYPE = 'price-series';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const orNull = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);
const dateOrNull = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);

/** The lower-case kebab status of pricing-data P4, and back. */
const STATUS_TO_ROW: Readonly<Record<RegularRecordStatus, string>> = {
  ACCEPTED: 'accepted',
  PENDING_REVIEW: 'pending-review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
};
const STATUS_FROM_ROW: Readonly<Record<string, RegularRecordStatus>> = Object.fromEntries(
  Object.entries(STATUS_TO_ROW).map(([domain, row]) => [row, domain as RegularRecordStatus]),
);

function statusFromRow(value: string): RegularRecordStatus {
  const status = STATUS_FROM_ROW[value];
  if (status === undefined) throw new Error('price series: unknown stored record status');
  return status;
}

/**
 * A stored amount. The CHECKs (pricing-data P1) and the foreign key on the series currency
 * (P2) already hold for it, and `PriceSeries.restore` checks the currency again; the policy
 * maximum of the day of writing is not re-applied to history.
 */
const storedAmount = (minor: bigint, currency: string): PriceAmount =>
  Object.freeze(money(minor, currency)) as PriceAmount;

/** One row of `pricing.regular_price_records`, as the client returns it. */
interface RecordRow {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly taxInclusive: boolean;
  readonly status: string;
  readonly submittedAt: Date;
  readonly submittedByAccountId: string;
  readonly anchorRecordId: string | null;
  readonly anchorAmountMinor: bigint | null;
  readonly holdDirection: string | null;
  readonly effectiveFrom: Date | null;
  readonly effectiveTo: Date | null;
  readonly supersededAt: Date | null;
  readonly supersededByRecordId: string | null;
  readonly supersedeCause: string | null;
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
  readonly regularRecords: readonly RecordRow[];
}

function recordFromRow(row: RecordRow): RegularPriceRecord {
  return {
    id: row.id as Id<'RegularPriceRecord'>,
    amount: storedAmount(row.amountMinor, row.currency),
    taxInclusive: row.taxInclusive,
    status: statusFromRow(row.status),
    submittedAt: toInstant(row.submittedAt),
    submittedBy: row.submittedByAccountId as Id<'Account'>,
    effectiveFrom: orNull(row.effectiveFrom),
    effectiveTo: orNull(row.effectiveTo),
    anchor:
      row.anchorRecordId === null || row.anchorAmountMinor === null
        ? null
        : {
            recordId: row.anchorRecordId as Id<'RegularPriceRecord'>,
            amount: storedAmount(row.anchorAmountMinor, row.currency),
          },
    heldDirection: row.holdDirection as 'up' | 'down' | null,
    supersededBy: row.supersededByRecordId as Id<'RegularPriceRecord'> | null,
    supersededAt: orNull(row.supersededAt),
    supersedeCause: row.supersedeCause as SupersedeCause | null,
  };
}

function seriesFromRow(row: SeriesRow): PriceSeries {
  return PriceSeries.restore({
    id: row.id as Id<'PriceSeries'>,
    marketId: row.marketId as MarketId,
    offerId: row.offerId as Id<'Offer'>,
    variantId: row.variantId as Id<'Variant'>,
    productId: row.productId as Id<'Product'>,
    sellerId: row.sellerId as Id<'Seller'>,
    currency: row.currency,
    createdAt: toInstant(row.createdAt),
    retiredAt: orNull(row.retiredAt),
    retireCause: row.retireCause as RetireCause | null,
    version: row.version,
    regular: row.regularRecords.map(recordFromRow),
  });
}

/** The columns a save may write on an existing record (pricing-data 7; the column grant). */
function recordChanges(record: RegularPriceRecord) {
  return {
    status: STATUS_TO_ROW[record.status],
    effectiveFrom: dateOrNull(record.effectiveFrom),
    effectiveTo: dateOrNull(record.effectiveTo),
    supersededAt: dateOrNull(record.supersededAt),
    supersededByRecordId: record.supersededBy,
    supersedeCause: record.supersedeCause,
  };
}

function sameChangeableColumns(a: RegularPriceRecord, b: RegularPriceRecord): boolean {
  const same = (x: Temporal.Instant | null, y: Temporal.Instant | null): boolean =>
    x === null || y === null ? x === y : x.epochMilliseconds === y.epochMilliseconds;
  return (
    a.status === b.status &&
    same(a.effectiveFrom, b.effectiveFrom) &&
    same(a.effectiveTo, b.effectiveTo) &&
    same(a.supersededAt, b.supersededAt) &&
    a.supersededBy === b.supersededBy &&
    a.supersedeCause === b.supersedeCause
  );
}

const RECORDS_IN_ORDER = {
  regularRecords: { orderBy: [{ submittedAt: 'asc' as const }, { id: 'asc' as const }] },
};

/**
 * {@link PriceSeriesRepository} on `pricing.price_series` and `pricing.regular_price_records`
 * (pricing-data 3.2, 3.3, 3.6). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; writes are single statements, never nested; no raw
 * SQL (H-D1). No row is ever deleted.
 *
 * Slice 1 loads a series with its whole regular history: `PriceSeries.restore` checks that the
 * priced records are contiguous, so a partial working set (pricing-data 6.2) waits for the live
 * index of migration 3 and a domain that accepts it.
 */
export class PrismaPriceSeriesRepository implements PriceSeriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(market: MarketContext, key: PriceSeriesKey): Promise<PriceSeries | null> {
    const row = await this.prisma.tx(market).pricingPriceSeries.findFirst({
      where: { marketId: market.marketId, offerId: key.offerId, variantId: key.variantId },
      include: RECORDS_IN_ORDER,
    });
    return row === null ? null : seriesFromRow(row);
  }

  async findByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<readonly PriceSeries[]> {
    const rows = await this.prisma.tx(market).pricingPriceSeries.findMany({
      where: { marketId: market.marketId, offerId },
      include: RECORDS_IN_ORDER,
      orderBy: { id: 'asc' },
    });
    return rows.map(seriesFromRow);
  }

  async findByProductVariant(
    market: MarketContext,
    productId: Id<'Product'>,
    variantId: Id<'Variant'>,
  ): Promise<readonly PriceSeries[]> {
    const rows = await this.prisma.tx(market).pricingPriceSeries.findMany({
      where: { marketId: market.marketId, productId, variantId },
      include: RECORDS_IN_ORDER,
      orderBy: { id: 'asc' },
    });
    return rows.map(seriesFromRow);
  }

  async add(market: MarketContext, series: PriceSeries): Promise<AddPriceSeriesOutcome> {
    const state = series.state;
    if (series.storedState !== null) throw new Error('add: the series is stored; use save');
    if (state.marketId !== market.marketId) throw new Error('add: the series is of another Market');
    const tx = this.prisma.tx(market);

    // Both tombstones by primary key (pricing-data 3.6, 6.2), read in the creating unit, which
    // runs serializable (5.1).
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

    const { count } = await tx.pricingPriceSeries.createMany({
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
          version: 1,
          createdAt: toDate(state.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    // Zero rows: the key (or the id) is taken, a lost creation race (P 10).
    if (count !== 1) throw new StaleAggregateError(AGGREGATE_TYPE, state.id);

    const inserted: PriceSeriesState = {
      ...state,
      retiredAt: null,
      retireCause: null,
      version: 1,
      regular: [],
    };
    await this.#write(market, inserted, state);
    series.markStored();
    return 'added';
  }

  async save(market: MarketContext, series: PriceSeries): Promise<void> {
    const stored = series.storedState;
    if (stored === null) throw new Error('save: the series was never stored; use add');
    if (series.state.marketId !== market.marketId) {
      throw new Error('save: the series is of another Market');
    }
    await this.#write(market, stored, series.state);
    series.markStored();
  }

  /**
   * Writes `next` over `stored` in the order of pricing-data P7: the version first (a concurrent
   * writer of the series waits on that row and then finds it stale), then the updates that shrink
   * (supersede, close a period), then the ones that start a period, then the new records.
   */
  async #write(market: MarketContext, stored: PriceSeriesState, next: PriceSeriesState) {
    if (next.version === stored.version) return;
    if (next.id !== stored.id) throw new Error('save: another series');
    const tx = this.prisma.tx(market);

    const { count } = await tx.pricingPriceSeries.updateMany({
      where: { marketId: market.marketId, id: next.id, version: stored.version },
      data: {
        version: next.version,
        retiredAt: dateOrNull(next.retiredAt),
        retireCause: next.retireCause,
      },
    });
    if (count !== 1) throw new StaleAggregateError(AGGREGATE_TYPE, next.id);

    const before = new Map(stored.regular.map((record) => [record.id, record]));
    if (stored.regular.some((record) => !next.regular.some((r) => r.id === record.id))) {
      throw new Error('save: a stored record is missing; records are never removed');
    }
    const changed = next.regular.filter((record) => {
      const old = before.get(record.id);
      return old !== undefined && !sameChangeableColumns(old, record);
    });
    // A record that starts a period (an approval, slice 4) comes after every shrink.
    const starts = (record: RegularPriceRecord): boolean =>
      before.get(record.id)?.effectiveFrom === null && record.effectiveFrom !== null;
    const ordered = [...changed.filter((record) => !starts(record)), ...changed.filter(starts)];
    for (const record of ordered) {
      const updated = await tx.pricingRegularPriceRecord.updateMany({
        where: { marketId: market.marketId, seriesId: next.id, id: record.id },
        data: recordChanges(record),
      });
      if (updated.count !== 1) {
        throw new Error('save: a stored record was not updated exactly once');
      }
    }

    const added = next.regular.filter((record) => !before.has(record.id));
    if (added.length === 0) return;
    await tx.pricingRegularPriceRecord.createMany({
      data: added.map((record) => {
        if (record.amount.currency !== next.currency) {
          throw new Error('save: a record in another currency than the series');
        }
        return {
          id: record.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          seriesId: next.id,
          amountMinor: record.amount.amount,
          currency: record.amount.currency,
          taxInclusive: record.taxInclusive,
          submittedAt: toDate(record.submittedAt),
          submittedByAccountId: record.submittedBy,
          anchorRecordId: record.anchor?.recordId ?? null,
          anchorAmountMinor: record.anchor?.amount.amount ?? null,
          holdDirection: record.heldDirection,
          ...recordChanges(record),
        };
      }),
    });
  }
}
