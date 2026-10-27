import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AccountPage,
  AppliedSchedule,
  ConnectedAccountRecord,
  ConnectedAccountStore,
  NewPayoutChange,
  PayoutChangeRecord,
} from '../application/ports/connected-account-store';
import type { AccountSnapshot, AccountStatus } from '../domain/connected-account';
import { hmacPrefix } from '../domain/external-account';
import type { ChangeKind } from '../domain/payout-change';

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
  coolingOffUntil: Date | null;
  payoutsPausedUntil: Date | null;
  payoutScheduleApplied: string | null;
  payoutScheduleRevision: number;
  lastChangeId: string | null;
  externalAccountHmac: string | null;
}

const optionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

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
  coolingOffUntil: optionalInstant(row.coolingOffUntil),
  payoutsPausedUntil: optionalInstant(row.payoutsPausedUntil),
  payoutScheduleApplied: row.payoutScheduleApplied as AppliedSchedule | null,
  payoutScheduleRevision: row.payoutScheduleRevision,
  lastChangeId: row.lastChangeId,
  externalAccountHmac: row.externalAccountHmac,
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

  async recordsOf(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ConnectedAccountRecord>> {
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
    });
    return new Map(rows.map((row) => [row.sellerId, record(row)]));
  }

  async recordChange(
    market: MarketContext,
    sellerId: string,
    change: NewPayoutChange,
    expectedLastChangeId: string | null,
    until: Temporal.Instant | null,
    at: Temporal.Instant,
  ): Promise<'recorded' | 'duplicate' | 'conflict'> {
    const tx = this.prisma.tx(market);
    if (change.sourceEventId !== null) {
      const seen = await tx.paymentsPayoutAccountChange.findFirst({
        where: { marketId: market.marketId, sourceEventId: change.sourceEventId },
        select: { id: true },
      });
      if (seen !== null) return 'duplicate';
    }
    // The account row first, and only while its latest change is the one this was computed from.
    const moved = await tx.paymentsConnectedAccount.updateMany({
      where: { marketId: market.marketId, sellerId, lastChangeId: expectedLastChangeId },
      data: {
        lastChangeId: change.id,
        coolingOffUntil: until === null ? null : toDate(until),
        payoutsPausedUntil: until === null ? null : toDate(until),
        // The new hash goes in with the change row, in this unit: nothing else may replace a
        // value with a different one under the same key version (design 4.6 condition 2 (v)).
        ...(change.externalAccountHmac === undefined
          ? {}
          : { externalAccountHmac: change.externalAccountHmac }),
        updatedAt: toDate(at),
      },
    });
    if (moved.count !== 1) return 'conflict';
    await tx.paymentsPayoutAccountChange.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: change.id,
        sellerId,
        kind: change.kind,
        detectedAt: toDate(change.detectedAt),
        coolingOffUntil: change.coolingOffUntil === null ? null : toDate(change.coolingOffUntil),
        sourceEventId: change.sourceEventId,
        detectedBy: change.detectedBy,
      },
    });
    return 'recorded';
  }

  async lockForTransfer(
    market: MarketContext,
    sellerId: string,
    at: Temporal.Instant,
  ): Promise<ConnectedAccountRecord | null> {
    const tx = this.prisma.tx(market);
    // An UPDATE takes the row lock until the unit ends, so a webhook unit that moves the same
    // row waits; the read after it sees what that unit committed (READ COMMITTED).
    const locked = await tx.paymentsConnectedAccount.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { updatedAt: toDate(at) },
    });
    if (locked.count !== 1) return null;
    const row = await tx.paymentsConnectedAccount.findFirst({
      where: { marketId: market.marketId, sellerId },
    });
    return row === null ? null : record(row);
  }

  async stampExternalAccountHmac(
    market: MarketContext,
    sellerId: string,
    expected: string | null,
    next: string,
    at: Temporal.Instant,
  ): Promise<'stamped' | 'conflict' | 'needs-change'> {
    // A different value under the same key version is a changed bank account: it is written only
    // by `recordChange`, together with its change row.
    if (expected !== null && expected !== next && hmacPrefix(expected) === hmacPrefix(next)) {
      return 'needs-change';
    }
    const updated = await this.prisma.tx(market).paymentsConnectedAccount.updateMany({
      where: { marketId: market.marketId, sellerId, externalAccountHmac: expected },
      data: { externalAccountHmac: next, updatedAt: toDate(at) },
    });
    return updated.count === 1 ? 'stamped' : 'conflict';
  }

  async changesOf(
    market: MarketContext,
    sellerId: string,
    limit: number,
  ): Promise<readonly PayoutChangeRecord[]> {
    const rows = await this.prisma.tx(market).paymentsPayoutAccountChange.findMany({
      where: { marketId: market.marketId, sellerId },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as ChangeKind,
      detectedAt: toInstant(row.detectedAt),
      coolingOffUntil: optionalInstant(row.coolingOffUntil),
    }));
  }

  async markRepause(
    market: MarketContext,
    sellerId: string,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsConnectedAccount.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: {
        payoutScheduleApplied: 'normal',
        payoutScheduleRevision: { increment: 1 },
        updatedAt: toDate(at),
      },
    });
    return updated.count === 1;
  }

  async dueForScheduleSync(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly ConnectedAccountRecord[]> {
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where: {
        marketId: market.marketId,
        accountRef: { not: null },
        OR: [
          // Paused now, not yet manual at Stripe.
          {
            payoutsPausedUntil: { gt: toDate(now) },
            OR: [{ payoutScheduleApplied: null }, { payoutScheduleApplied: 'normal' }],
          },
          // Not paused any more, still manual at Stripe.
          {
            payoutScheduleApplied: 'manual',
            OR: [{ payoutsPausedUntil: null }, { payoutsPausedUntil: { lte: toDate(now) } }],
          },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { sellerId: 'asc' }],
      take: limit,
    });
    return rows.map(record);
  }

  async markScheduleApplied(
    market: MarketContext,
    sellerId: string,
    applied: AppliedSchedule,
    at: Temporal.Instant,
    expected: { readonly lastChangeId: string; readonly revision: number },
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsConnectedAccount.updateMany({
      where: {
        marketId: market.marketId,
        sellerId,
        lastChangeId: expected.lastChangeId,
        payoutScheduleRevision: expected.revision,
      },
      data: { payoutScheduleApplied: applied, updatedAt: toDate(at) },
    });
    return updated.count === 1;
  }

  async bumpScheduleRevision(
    market: MarketContext,
    sellerId: string,
    expectedRevision: number,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const updated = await this.prisma.tx(market).paymentsConnectedAccount.updateMany({
      where: { marketId: market.marketId, sellerId, payoutScheduleRevision: expectedRevision },
      data: { payoutScheduleRevision: { increment: 1 }, updatedAt: toDate(at) },
    });
    return updated.count === 1;
  }

  async list(
    market: MarketContext,
    status: AccountStatus | null,
    page: AccountPage,
  ): Promise<readonly ConnectedAccountRecord[]> {
    const after = page.after;
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where: {
        marketId: market.marketId,
        ...(status === null ? {} : { status }),
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: toDate(after.createdAt) } },
                { createdAt: toDate(after.createdAt), sellerId: { lt: after.sellerId } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { sellerId: 'desc' }],
      take: page.limit + 1,
    });
    return rows.map(record);
  }
}
