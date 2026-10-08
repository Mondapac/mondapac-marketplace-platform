import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { TaxProfileRepository } from '../application/ports/tax-profile.repository';
import {
  SellerTaxProfile,
  TAX_RECORDERS,
  type TaxRecorderKind,
  type TaxRegistrationPeriod,
} from '../domain/tax-registration';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
/** A `date` column is read as midnight UTC of that calendar day. */
const toLocalDate = (date: Date): Temporal.PlainDate =>
  Temporal.PlainDate.from(date.toISOString().slice(0, 10));
const fromLocalDate = (date: Temporal.PlainDate): Date => new Date(`${date.toString()}T00:00:00Z`);

/** A stored row that breaks the domain's rules: a fault of the data, never a value to use. */
export class StoredTaxPeriodError extends Error {
  override readonly name = 'StoredTaxPeriodError';
  constructor(column: string) {
    super(`sellers.tax_registration_periods holds an invalid ${column}`);
  }
}

/**
 * {@link TaxProfileRepository} on `sellers.seller_tax_profiles` and
 * `sellers.tax_registration_periods` (data design 3.7). Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`; writes are single
 * statements, never nested. The root is written first: it takes the row lock that serialises two
 * recordings for one seller, and its version guard is the optimistic check.
 */
export class PrismaTaxProfileRepository implements TaxProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findBySellerId(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<SellerTaxProfile | null> {
    const tx = this.prisma.tx(market);
    const root = await tx.sellersSellerTaxProfile.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { sellerId: true, marketId: true, version: true },
    });
    if (root === null) return null;
    const rows = await tx.sellersTaxRegistrationPeriod.findMany({
      where: { marketId: market.marketId, sellerId },
      orderBy: { validFrom: 'asc' },
    });
    const periods = rows.map((row): TaxRegistrationPeriod => {
      if (!(TAX_RECORDERS as readonly string[]).includes(row.recordedByKind)) {
        throw new StoredTaxPeriodError('recorded_by_kind');
      }
      return {
        id: row.id as Id<'TaxRegistrationPeriod'>,
        registeredForIndirectTax: row.registeredForIndirectTax,
        effectiveFromLocal: toLocalDate(row.effectiveFromLocal),
        effectiveZone: row.effectiveZone,
        validFrom: toInstant(row.validFrom),
        validTo: row.validTo === null ? null : toInstant(row.validTo),
        recordedBy: {
          kind: row.recordedByKind as TaxRecorderKind,
          accountId: row.recordedByAccountId as Id<'Account'>,
        },
        recordedAt: toInstant(row.recordedAt),
      };
    });
    return SellerTaxProfile.restore({
      sellerId: root.sellerId as Id<'Seller'>,
      marketId: root.marketId as MarketId,
      version: root.version,
      periods,
    });
  }

  async save(market: MarketContext, profile: SellerTaxProfile): Promise<boolean> {
    if (profile.version !== profile.persistedVersion + 1) {
      // A profile saved without a change, or after several: one save writes exactly one change.
      if (profile.version === profile.persistedVersion) return true;
      throw new RangeError('save: one save raises the version by exactly one');
    }
    const tx = this.prisma.tx(market);
    const { count } = await tx.sellersSellerTaxProfile.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: profile.sellerId,
        version: profile.persistedVersion,
      },
      data: { version: profile.version },
    });
    if (count !== 1) return false;

    const { deleted, validToChanged, inserted } = profile.changes;
    if (deleted.length > 0) {
      await tx.sellersTaxRegistrationPeriod.deleteMany({
        where: { marketId: market.marketId, sellerId: profile.sellerId, id: { in: [...deleted] } },
      });
    }
    for (const { id, validTo } of validToChanged) {
      await tx.sellersTaxRegistrationPeriod.updateMany({
        where: { marketId: market.marketId, sellerId: profile.sellerId, id },
        data: { validTo: validTo === null ? null : toDate(validTo) },
      });
    }
    for (const period of inserted) {
      await tx.sellersTaxRegistrationPeriod.create({
        data: {
          id: period.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: profile.sellerId,
          registeredForIndirectTax: period.registeredForIndirectTax,
          effectiveFromLocal: fromLocalDate(period.effectiveFromLocal),
          effectiveZone: period.effectiveZone,
          validFrom: toDate(period.validFrom),
          validTo: period.validTo === null ? null : toDate(period.validTo),
          recordedByKind: period.recordedBy.kind,
          recordedByAccountId: period.recordedBy.accountId,
          recordedAt: toDate(period.recordedAt),
        },
        select: { id: true },
      });
    }
    return true;
  }
}
