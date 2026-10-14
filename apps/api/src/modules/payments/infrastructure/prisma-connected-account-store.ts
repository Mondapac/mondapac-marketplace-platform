import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ConnectedAccountRecord,
  ConnectedAccountStore,
} from '../application/ports/connected-account-store';
import type { AccountSnapshot, AccountStatus } from '../domain/connected-account';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface Row {
  sellerId: string;
  accountRef: string | null;
  status: string;
  detailsSubmitted: boolean;
  transfersActive: boolean;
  payoutsEnabled: boolean;
  requirementsDue: number;
  requirementsPastDue: boolean;
  lastReadAt: Date | null;
  createdAt: Date;
}

const record = (row: Row): ConnectedAccountRecord => ({
  sellerId: row.sellerId,
  accountRef: row.accountRef,
  status: row.status as AccountStatus,
  detailsSubmitted: row.detailsSubmitted,
  transfersActive: row.transfersActive,
  payoutsEnabled: row.payoutsEnabled,
  requirementsDue: row.requirementsDue,
  requirementsPastDue: row.requirementsPastDue,
  lastReadAt: row.lastReadAt === null ? null : toInstant(row.lastReadAt),
  createdAt: toInstant(row.createdAt),
});

/** `payments.connected_accounts` through the unit of work's transaction. */
export class PrismaConnectedAccountStore implements ConnectedAccountStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, sellerId: string): Promise<ConnectedAccountRecord | null> {
    const row = await this.prisma.tx(market).paymentsConnectedAccount.findFirst({
      where: { marketId: market.marketId, sellerId },
    });
    return row === null ? null : record(row);
  }

  async findByRef(
    market: MarketContext,
    accountRef: string,
  ): Promise<ConnectedAccountRecord | null> {
    const row = await this.prisma.tx(market).paymentsConnectedAccount.findFirst({
      where: { marketId: market.marketId, accountRef },
    });
    return row === null ? null : record(row);
  }

  async insert(market: MarketContext, sellerId: string, at: Temporal.Instant): Promise<boolean> {
    const created = await this.prisma.tx(market).paymentsConnectedAccount.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId,
          accountRef: null,
          status: 'not-started',
          detailsSubmitted: false,
          transfersActive: false,
          payoutsEnabled: false,
          requirementsDue: 0,
          requirementsPastDue: false,
          createdAt: toDate(at),
          updatedAt: toDate(at),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async linkRef(
    market: MarketContext,
    sellerId: string,
    accountRef: string,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsConnectedAccount.updateMany({
      where: { marketId: market.marketId, sellerId, accountRef: null },
      data: { accountRef, updatedAt: toDate(at) },
    });
    return updated.count === 1;
  }

  async applyRead(
    market: MarketContext,
    sellerId: string,
    snapshot: AccountSnapshot,
    status: AccountStatus,
    readAt: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsConnectedAccount.updateMany({
      where: {
        marketId: market.marketId,
        sellerId,
        accountRef: snapshot.id,
        OR: [{ lastReadAt: null }, { lastReadAt: { lt: toDate(readAt) } }],
      },
      data: {
        status,
        detailsSubmitted: snapshot.detailsSubmitted,
        transfersActive: snapshot.transfersActive,
        payoutsEnabled: snapshot.payoutsEnabled,
        requirementsDue: snapshot.requirementsDue,
        requirementsPastDue: snapshot.requirementsPastDue,
        updatedAt: toDate(readAt),
        lastReadAt: toDate(readAt),
      },
    });
    return updated.count === 1;
  }

  async statusesOf(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlyMap<string, AccountStatus>> {
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
      select: { sellerId: true, status: true },
    });
    return new Map(rows.map((row) => [row.sellerId, row.status as AccountStatus]));
  }
}
