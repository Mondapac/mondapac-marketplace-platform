import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  InAppNoticeRepository,
  NewNotice,
  NoticeFilter,
  NoticeOwner,
  NoticeScope,
  StoredNotice,
} from '../application/ports/in-app-notice.repository';

const instant = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime());
const date = (at: Temporal.Instant) => new Date(at.epochMilliseconds);

/** The rows of one owner (the Market is added by each query). */
function ownerRows(owner: NoticeOwner) {
  return owner.audience === 'seller'
    ? { audience: 'seller', sellerId: owner.sellerId }
    : { audience: 'admin', sellerId: null };
}

/** The rows one reader may see (the Market is added by each query). */
function readerScope(scope: NoticeScope) {
  return {
    ...ownerRows(scope.owner),
    kind: { in: [...scope.kinds] },
    createdAt: { gte: date(scope.since) },
  };
}

/**
 * {@link InAppNoticeRepository} on `notifications.in_app_notices` and `in_app_notice_reads`,
 * scoped by `marketId`. Ids are UUIDv7: `id` order is creation order to the millisecond, and an
 * arbitrary but stable order inside one, which is all the list's cursor and the cap need.
 */
export class PrismaInAppNoticeRepository implements InAppNoticeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, notices: readonly NewNotice[]) {
    if (notices.length === 0) return;
    await this.prisma.tx(market).notificationsInAppNotice.createMany({
      data: notices.map((notice) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: notice.id,
        ...ownerRows(notice.owner),
        kind: notice.kind,
        params: { ...notice.params },
        createdAt: date(notice.createdAt),
      })),
    });
  }

  async trim(market: MarketContext, owner: NoticeOwner, keep: number, kind?: string) {
    const tx = this.prisma.tx(market);
    const rows = {
      marketId: market.marketId,
      ...ownerRows(owner),
      ...(kind === undefined ? {} : { kind }),
    };
    const edge = await tx.notificationsInAppNotice.findFirst({
      where: rows,
      orderBy: { id: 'desc' },
      skip: keep - 1,
      select: { id: true },
    });
    if (edge === null) return 0;
    const deleted = await tx.notificationsInAppNotice.deleteMany({
      where: { ...rows, id: { lt: edge.id } },
    });
    return deleted.count;
  }

  async list(
    market: MarketContext,
    scope: NoticeScope,
    page: {
      readonly before: Id<'InAppNotice'> | null;
      readonly limit: number;
      readonly show: NoticeFilter;
    },
  ): Promise<readonly StoredNotice[]> {
    const mine = { accountId: scope.accountId };
    const rows = await this.prisma.tx(market).notificationsInAppNotice.findMany({
      where: {
        marketId: market.marketId,
        ...readerScope(scope),
        ...(page.before === null ? {} : { id: { lt: page.before } }),
        ...(page.show === 'unread' ? { reads: { none: mine } } : {}),
        ...(page.show === 'read' ? { reads: { some: mine } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit,
      select: {
        id: true,
        kind: true,
        params: true,
        createdAt: true,
        reads: { where: { accountId: scope.accountId }, select: { accountId: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id as Id<'InAppNotice'>,
      kind: row.kind,
      params: row.params,
      createdAt: instant(row.createdAt),
      read: row.reads.length > 0,
    }));
  }

  async unread(market: MarketContext, scope: NoticeScope) {
    const tx = this.prisma.tx(market);
    const where = {
      marketId: market.marketId,
      ...readerScope(scope),
      reads: { none: { accountId: scope.accountId } },
    };
    const [count, newest] = await Promise.all([
      tx.notificationsInAppNotice.count({ where }),
      tx.notificationsInAppNotice.findFirst({
        where,
        orderBy: { id: 'desc' },
        select: { id: true, kind: true, params: true, createdAt: true },
      }),
    ]);
    return {
      count,
      newest:
        newest === null
          ? null
          : {
              id: newest.id as Id<'InAppNotice'>,
              kind: newest.kind,
              params: newest.params,
              createdAt: instant(newest.createdAt),
              read: false,
            },
    };
  }

  async exists(market: MarketContext, scope: NoticeScope, id: Id<'InAppNotice'>) {
    const row = await this.prisma.tx(market).notificationsInAppNotice.findFirst({
      where: { marketId: market.marketId, ...readerScope(scope), id },
      select: { id: true },
    });
    return row !== null;
  }

  async unreadIds(
    market: MarketContext,
    scope: NoticeScope,
    ids: readonly Id<'InAppNotice'>[] | 'all',
  ) {
    const rows = await this.prisma.tx(market).notificationsInAppNotice.findMany({
      where: {
        marketId: market.marketId,
        ...readerScope(scope),
        ...(ids === 'all' ? {} : { id: { in: [...ids] } }),
        reads: { none: { accountId: scope.accountId } },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'InAppNotice'>);
  }

  async markRead(
    market: MarketContext,
    accountId: Id<'Account'>,
    ids: readonly Id<'InAppNotice'>[],
    readAt: Temporal.Instant,
  ) {
    if (ids.length === 0) return 0;
    const created = await this.prisma.tx(market).notificationsInAppNoticeRead.createMany({
      data: ids.map((noticeId) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        noticeId,
        accountId,
        readAt: date(readAt),
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  async purgeBefore(market: MarketContext, cutoff: Temporal.Instant) {
    const deleted = await this.prisma.tx(market).notificationsInAppNotice.deleteMany({
      where: { marketId: market.marketId, createdAt: { lt: date(cutoff) } },
    });
    return deleted.count;
  }
}
