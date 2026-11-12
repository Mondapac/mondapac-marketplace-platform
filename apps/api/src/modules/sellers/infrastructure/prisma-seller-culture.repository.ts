import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerCultureRepository } from '../application/ports/seller-culture.repository';
import type { SellerCultureState, SellerCultureStatus } from '../domain/seller-culture';

const instantOf = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const dateOf = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const SELECT = {
  sellerId: true,
  cultureId: true,
  cultureCode: true,
  status: true,
  reason: true,
  requestedBy: true,
  requestedAt: true,
  decidedBy: true,
  decidedAt: true,
  version: true,
  updatedAt: true,
} as const;

type Row = {
  sellerId: string;
  cultureId: string;
  cultureCode: string;
  status: string;
  reason: string | null;
  requestedBy: string | null;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  version: number;
  updatedAt: Date;
};

const stateOf = (row: Row): SellerCultureState => ({
  sellerId: row.sellerId as Id<'Seller'>,
  cultureId: row.cultureId as Id<'Culture'>,
  cultureCode: row.cultureCode,
  status: row.status as SellerCultureStatus,
  reason: row.reason,
  requestedBy: row.requestedBy as Id<'Account'> | null,
  requestedAt: instantOf(row.requestedAt),
  decidedBy: row.decidedBy as Id<'Account'> | null,
  decidedAt: row.decidedAt === null ? null : instantOf(row.decidedAt),
  version: row.version,
  updatedAt: instantOf(row.updatedAt),
});

/** {@link SellerCultureRepository} on `sellers.seller_cultures`, every statement scoped by the Market. */
export class PrismaSellerCultureRepository implements SellerCultureRepository {
  constructor(private readonly prisma: PrismaService) {}

  async forSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<readonly SellerCultureState[]> {
    const rows = await this.prisma.tx(market).sellersSellerCulture.findMany({
      where: { marketId: market.marketId, sellerId },
      select: SELECT,
      orderBy: [{ cultureCode: 'asc' }, { cultureId: 'asc' }],
      take: 200,
    });
    return rows.map(stateOf);
  }

  async among(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<ReadonlyMap<Id<'Culture'>, SellerCultureState>> {
    if (cultureIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).sellersSellerCulture.findMany({
      where: { marketId: market.marketId, sellerId, cultureId: { in: [...cultureIds] } },
      select: SELECT,
    });
    return new Map(rows.map((row) => [row.cultureId as Id<'Culture'>, stateOf(row)]));
  }

  async sellerIdsWithoutCultures(
    market: MarketContext,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]> {
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: { marketId: market.marketId, cultures: { none: {} } },
      select: { sellerId: true },
      orderBy: [{ createdAt: 'asc' }, { sellerId: 'asc' }],
      take: limit,
    });
    return rows.map((row) => row.sellerId as Id<'Seller'>);
  }

  async insert(market: MarketContext, state: SellerCultureState): Promise<boolean> {
    // A concurrent first request of the same pair hits the primary key and inserts nothing.
    const { count } = await this.prisma.tx(market).sellersSellerCulture.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: state.sellerId,
          cultureId: state.cultureId,
          cultureCode: state.cultureCode,
          status: state.status,
          reason: state.reason,
          requestedBy: state.requestedBy,
          requestedAt: dateOf(state.requestedAt),
          decidedBy: state.decidedBy,
          decidedAt: state.decidedAt === null ? null : dateOf(state.decidedAt),
          version: state.version,
          updatedAt: dateOf(state.updatedAt),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async transition(
    market: MarketContext,
    state: SellerCultureState,
    expected: { readonly version: number; readonly status: 'requested' | 'rejected' },
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).sellersSellerCulture.updateMany({
      where: {
        marketId: market.marketId,
        sellerId: state.sellerId,
        cultureId: state.cultureId,
        status: expected.status,
        version: expected.version,
      },
      data: {
        status: state.status,
        reason: state.reason,
        requestedBy: state.requestedBy,
        requestedAt: dateOf(state.requestedAt),
        decidedBy: state.decidedBy,
        decidedAt: state.decidedAt === null ? null : dateOf(state.decidedAt),
        version: state.version,
        updatedAt: dateOf(state.updatedAt),
      },
    });
    return count === 1;
  }
}
