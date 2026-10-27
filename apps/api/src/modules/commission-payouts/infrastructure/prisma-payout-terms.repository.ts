import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PayoutTermsOverrideRecord,
  PayoutTermsRepository,
} from '../application/ports/payout-terms.repository';
import {
  localTimeToMinute,
  maskToWeekdays,
  minuteToLocalTime,
  weekdaysToMask,
  type ApprovalMode,
} from '../domain/payout-terms';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

interface Row {
  readonly sellerId: string;
  readonly scheduleWeekdays: number | null;
  readonly localMinute: number | null;
  readonly holdDaysCarrier: number | null;
  readonly holdDaysSellerClick: number | null;
  readonly minimumMinor: bigint | null;
  readonly approvalMode: string | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

const toRecord = (row: Row): PayoutTermsOverrideRecord => ({
  sellerId: row.sellerId as Id<'Seller'>,
  override: {
    weekdays: row.scheduleWeekdays === null ? null : maskToWeekdays(row.scheduleWeekdays),
    localTime: row.localMinute === null ? null : minuteToLocalTime(row.localMinute),
    holdDaysCarrier: row.holdDaysCarrier,
    holdDaysSellerClick: row.holdDaysSellerClick,
    minimumMinor: row.minimumMinor,
    approvalMode: row.approvalMode as ApprovalMode | null,
  },
  version: row.version,
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
  updatedBy: row.updatedBy as Id<'Account'>,
});

const valuesOf = (record: PayoutTermsOverrideRecord) => ({
  scheduleWeekdays:
    record.override.weekdays === null ? null : weekdaysToMask(record.override.weekdays),
  localMinute:
    record.override.localTime === null ? null : localTimeToMinute(record.override.localTime),
  holdDaysCarrier: record.override.holdDaysCarrier,
  holdDaysSellerClick: record.override.holdDaysSellerClick,
  minimumMinor: record.override.minimumMinor,
  approvalMode: record.override.approvalMode,
  version: record.version,
  updatedAt: toDate(record.updatedAt),
  updatedBy: record.updatedBy,
});

/**
 * {@link PayoutTermsRepository} on `commission_payouts.payout_terms_overrides`, scoped by
 * `marketId` in every `where`. The write conditions on the stored version, so two admins cannot
 * both win.
 */
export class PrismaPayoutTermsRepository implements PayoutTermsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = await this.prisma.tx(market).commissionPayoutsPayoutTermsOverride.findFirst({
      where: { marketId: market.marketId, sellerId },
    });
    return row === null ? null : toRecord(row);
  }

  async insert(market: MarketContext, record: PayoutTermsOverrideRecord): Promise<boolean> {
    const created = await this.prisma.tx(market).commissionPayoutsPayoutTermsOverride.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: record.sellerId,
          ...valuesOf(record),
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  async replace(
    market: MarketContext,
    record: PayoutTermsOverrideRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).commissionPayoutsPayoutTermsOverride.updateMany({
      where: { marketId: market.marketId, sellerId: record.sellerId, version: expectedVersion },
      data: valuesOf(record),
    });
    return updated.count > 0;
  }

  async remove(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    expectedVersion: number,
  ): Promise<boolean> {
    const removed = await this.prisma.tx(market).commissionPayoutsPayoutTermsOverride.deleteMany({
      where: { marketId: market.marketId, sellerId, version: expectedVersion },
    });
    return removed.count > 0;
  }
}
