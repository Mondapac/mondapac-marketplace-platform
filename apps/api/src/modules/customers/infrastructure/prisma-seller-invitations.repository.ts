import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  ATTRIBUTION_VIEWS,
  type AttributionListRecord,
  type AttributionView,
  type InviteLinkRepository,
  type SellerAttributionRepository,
  type ZonedAttributionSelector,
} from '../application/ports/seller-invitations.repository';
import type {
  AttributionFlag,
  AttributionRejectReason,
  AttributionStatus,
  InviteLink,
  SellerAttribution,
} from '../domain/seller-invitations';
import { localDayEnd, localDayStart } from '../domain/local-day';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
/** A day of a filter, already validated, as the instants it starts and ends in the query's zone. */
const startOfDay = (day: string, zone: string): Date =>
  new Date((localDayStart(day, zone) as Temporal.Instant).epochMilliseconds);
const startOfNextDay = (day: string, zone: string): Date =>
  new Date((localDayEnd(day, zone) as Temporal.Instant).epochMilliseconds);

type LinkRow = Prisma.CustomersSellerInviteLinkGetPayload<object>;
type AttributionRow = Prisma.CustomersSellerAttributionGetPayload<object>;
type ListedRow = Prisma.CustomersSellerAttributionGetPayload<{
  include: { directory: { select: { email: true; displayName: true } } };
}>;
type Where = Prisma.CustomersSellerAttributionWhereInput;

const linkOf = (row: LinkRow): InviteLink => ({
  id: row.id as Id<'SellerInviteLink'>,
  sellerId: row.sellerId as Id<'Seller'>,
  token: row.token,
  createdByAccountId: row.createdByAccountId as Id<'Account'>,
  createdAt: toInstant(row.createdAt),
  revokedAt: row.revokedAt === null ? null : toInstant(row.revokedAt),
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** {@link InviteLinkRepository} on `customers.seller_invite_links`. */
export class PrismaInviteLinkRepository implements InviteLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async liveOf(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = await this.prisma.tx(market).customersSellerInviteLink.findFirst({
      where: { marketId: market.marketId, sellerId, revokedAt: null },
    });
    return row === null ? null : linkOf(row);
  }

  async findByToken(market: MarketContext, token: string) {
    const row = await this.prisma.tx(market).customersSellerInviteLink.findFirst({
      where: { marketId: market.marketId, token },
    });
    return row === null ? null : linkOf(row);
  }

  async lockLive(market: MarketContext, linkId: Id<'SellerInviteLink'>) {
    // An UPDATE that changes nothing still takes the row lock until the unit ends (no raw SQL).
    const locked = await this.prisma.tx(market).customersSellerInviteLink.updateMany({
      where: { marketId: market.marketId, id: linkId, revokedAt: null },
      data: { revokedAt: null },
    });
    return locked.count === 1;
  }

  async replace(market: MarketContext, link: InviteLink, at: Temporal.Instant) {
    const tx = this.prisma.tx(market);
    await tx.customersSellerInviteLink.updateMany({
      where: { marketId: market.marketId, sellerId: link.sellerId, revokedAt: null },
      data: { revokedAt: toDate(at) },
    });
    try {
      await tx.customersSellerInviteLink.createMany({
        data: [
          {
            id: link.id,
            marketId: market.marketId,
            tenantId: market.tenantId,
            sellerId: link.sellerId,
            token: link.token,
            createdByAccountId: link.createdByAccountId,
            createdAt: toDate(link.createdAt),
            revokedAt: null,
          },
        ],
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'conflict' as const;
      throw error;
    }
    return 'ok' as const;
  }
}

const attributionOf = (row: AttributionRow): SellerAttribution => ({
  accountId: row.accountId as Id<'Account'>,
  sellerId: row.sellerId as Id<'Seller'>,
  linkId: row.linkId as Id<'SellerInviteLink'>,
  attributedAt: toInstant(row.attributedAt),
  status: row.status as AttributionStatus,
  rejectReason: row.rejectReason as AttributionRejectReason | null,
  flags: row.flags as AttributionFlag[],
  decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
  decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
  version: row.version,
});

const listedOf = (row: ListedRow): AttributionListRecord => ({
  ...attributionOf(row),
  email: row.directory.email,
  displayName: row.directory.displayName,
});

const LISTED = { directory: { select: { email: true, displayName: true } } } as const;

/** The rows of a view: `suspicious` is rejected or flagged (a partial index serves it). */
function viewWhere(view: AttributionView): Where {
  switch (view) {
    case 'suspicious':
      return { OR: [{ status: 'rejected' }, { NOT: { flags: { isEmpty: true } } }] };
    case 'all':
      return {};
    case 'active':
      return { status: 'active' };
    case 'rejected':
      return { status: 'rejected' };
  }
}

function whereOf(market: MarketContext, selector: ZonedAttributionSelector): Where {
  const and: Where[] = [viewWhere(selector.view)];
  if (selector.emailPrefix !== null) {
    and.push({ directory: { emailLower: { startsWith: selector.emailPrefix } } });
  }
  if (selector.sellerId !== null) and.push({ sellerId: selector.sellerId });
  if (selector.status !== null) and.push({ status: selector.status });
  if (selector.rejectReason !== null) and.push({ rejectReason: selector.rejectReason });
  if (selector.flag !== null) and.push({ flags: { has: selector.flag } });
  if (selector.attributedFrom !== null || selector.attributedTo !== null) {
    and.push({
      attributedAt: {
        ...(selector.attributedFrom === null
          ? {}
          : { gte: startOfDay(selector.attributedFrom, selector.dayZone) }),
        ...(selector.attributedTo === null
          ? {}
          : { lt: startOfNextDay(selector.attributedTo, selector.dayZone) }),
      },
    });
  }
  // The Market at the top level of the statement (the Market guard reads it there).
  return { marketId: market.marketId, AND: and };
}

/** {@link SellerAttributionRepository} on `customers.seller_attributions`. */
export class PrismaSellerAttributionRepository implements SellerAttributionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOf(market: MarketContext, accountId: Id<'Account'>) {
    const row = await this.prisma.tx(market).customersSellerAttribution.findFirst({
      where: { marketId: market.marketId, accountId },
    });
    return row === null ? null : attributionOf(row);
  }

  async insert(market: MarketContext, attribution: SellerAttribution) {
    const created = await this.prisma.tx(market).customersSellerAttribution.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: attribution.accountId,
          sellerId: attribution.sellerId,
          linkId: attribution.linkId,
          attributedAt: toDate(attribution.attributedAt),
          status: attribution.status,
          rejectReason: attribution.rejectReason,
          flags: [...attribution.flags],
          decidedByAccountId: attribution.decidedByAccountId,
          decidedAt: attribution.decidedAt === null ? null : toDate(attribution.decidedAt),
          version: attribution.version,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1 ? ('ok' as const) : ('exists' as const);
  }

  async update(market: MarketContext, attribution: SellerAttribution, expectedVersion: number) {
    const updated = await this.prisma.tx(market).customersSellerAttribution.updateMany({
      where: {
        marketId: market.marketId,
        accountId: attribution.accountId,
        version: expectedVersion,
      },
      data: {
        status: attribution.status,
        rejectReason: attribution.rejectReason,
        decidedByAccountId: attribution.decidedByAccountId,
        decidedAt: attribution.decidedAt === null ? null : toDate(attribution.decidedAt),
        version: attribution.version,
      },
    });
    return updated.count === 1;
  }

  countOfSellerSince(market: MarketContext, sellerId: Id<'Seller'>, since: Temporal.Instant) {
    return this.prisma.tx(market).customersSellerAttribution.count({
      where: { marketId: market.marketId, sellerId, attributedAt: { gte: toDate(since) } },
    });
  }

  async countsOfSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    const groups = await this.prisma.tx(market).customersSellerAttribution.groupBy({
      by: ['status'],
      where: { marketId: market.marketId, sellerId },
      _count: { _all: true },
    });
    const counts: Record<AttributionStatus, number> = { active: 0, rejected: 0 };
    for (const group of groups) {
      if (group.status === 'active' || group.status === 'rejected') {
        counts[group.status] = group._count._all;
      }
    }
    return counts;
  }

  async page(
    market: MarketContext,
    selector: ZonedAttributionSelector,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    const rows = await this.prisma.tx(market).customersSellerAttribution.findMany({
      where: whereOf(market, selector),
      include: LISTED,
      orderBy: [{ attributedAt: direction }, { accountId: direction }],
      skip: window.offset,
      take: window.limit,
    });
    return rows.map(listedOf);
  }

  count(market: MarketContext, selector: ZonedAttributionSelector) {
    return this.prisma
      .tx(market)
      .customersSellerAttribution.count({ where: whereOf(market, selector) });
  }

  async viewCounts(market: MarketContext) {
    const counts = await Promise.all(
      ATTRIBUTION_VIEWS.map((view) =>
        this.prisma.tx(market).customersSellerAttribution.count({
          where: { marketId: market.marketId, AND: [viewWhere(view)] },
        }),
      ),
    );
    return Object.fromEntries(
      ATTRIBUTION_VIEWS.map((view, index) => [view, counts[index]!]),
    ) as Record<AttributionView, number>;
  }

  async accountIds(market: MarketContext, selector: ZonedAttributionSelector, limit: number) {
    const rows = await this.prisma.tx(market).customersSellerAttribution.findMany({
      where: whereOf(market, selector),
      select: { accountId: true },
      orderBy: [{ attributedAt: 'desc' }, { accountId: 'desc' }],
      take: limit,
    });
    return rows.map((row) => row.accountId as Id<'Account'>);
  }

  async findListed(market: MarketContext, accountIds: readonly Id<'Account'>[]) {
    if (accountIds.length === 0) return [];
    const rows = await this.prisma.tx(market).customersSellerAttribution.findMany({
      where: { marketId: market.marketId, accountId: { in: [...accountIds] } },
      include: LISTED,
    });
    const byAccount = new Map(rows.map((row) => [row.accountId, listedOf(row)]));
    return accountIds.flatMap((accountId) => {
      const record = byAccount.get(accountId);
      return record === undefined ? [] : [record];
    });
  }
}
