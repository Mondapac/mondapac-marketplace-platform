import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import { escapeLikeTerm } from '../../../platform/text/like-escape';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CustomerListQuery,
  CustomerListReader,
} from '../application/ports/customer-list.reader';
import {
  ACTIVE_WINDOW_DAYS,
  CUSTOMER_VIEWS,
  NEW_WINDOW_DAYS,
  type CustomerListRow,
  type CustomerSort,
  type CustomerView,
  type SortDirection,
} from '../domain/customer-list';
import { emailSearchKey } from '../domain/customer-read-models';
import { localDayEnd, localDayStart } from '../domain/local-day';

const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
/** A day of a filter, already validated, as the instants it starts and ends in the query's zone. */
const startOfDay = (day: string, zone: string): Date =>
  new Date((localDayStart(day, zone) as Temporal.Instant).epochMilliseconds);
const startOfNextDay = (day: string, zone: string): Date =>
  new Date((localDayEnd(day, zone) as Temporal.Instant).epochMilliseconds);
const daysBefore = (now: Temporal.Instant, days: number): Date =>
  new Date(now.epochMilliseconds - days * 24 * 3_600_000);

/** Pending deletion requests are few (the buyer waits days); the tab reads up to this many. */
const PENDING_CAP = 5000;

type Where = Prisma.CustomersCustomerDirectoryWhereInput;
/** What a list row reads beside the directory row: the stats and the groups it is in. */
const INCLUDE = {
  stats: true,
  groupMemberships: {
    select: { group: { select: { id: true, name: true, archivedAt: true } } },
    orderBy: [{ addedAt: 'asc' }, { groupId: 'asc' }],
  },
} as const satisfies Prisma.CustomersCustomerDirectoryInclude;

type DirectoryRow = Prisma.CustomersCustomerDirectoryGetPayload<{ include: typeof INCLUDE }>;

const rowOf = (row: DirectoryRow): CustomerListRow => ({
  accountId: row.accountId as Id<'Account'>,
  email: row.email,
  displayName: row.displayName,
  status: row.status === 'disabled' ? 'disabled' : 'active',
  emailVerified: row.emailVerified,
  signedUpAt: toInstant(row.signedUpAt),
  firstOrderAt: row.stats?.firstOrderAt ? toInstant(row.stats.firstOrderAt) : null,
  lastOrderAt: row.stats?.lastOrderAt ? toInstant(row.stats.lastOrderAt) : null,
  orderCount: row.stats?.orderCount ?? 0,
  spentMinor: row.stats?.spentMinor ?? 0n,
  currency: row.stats?.currency ?? null,
  refundCount: row.stats?.refundCount ?? 0,
  refundedMinor: row.stats?.refundedMinor ?? 0n,
  groups: row.groupMemberships.map(({ group }) => ({
    groupId: group.id,
    name: group.name,
    archived: group.archivedAt !== null,
  })),
});

/**
 * {@link CustomerListReader} on `customers.customer_directory` joined to `customer_stats` through
 * the Prisma relation. Every statement carries `marketId`; no raw SQL.
 */
export class PrismaCustomerListReader implements CustomerListReader {
  constructor(private readonly prisma: PrismaService) {}

  async rows(
    market: MarketContext,
    query: CustomerListQuery,
    order: { readonly sort: CustomerSort; readonly direction: SortDirection },
    page: { readonly offset: number; readonly limit: number },
  ): Promise<readonly CustomerListRow[]> {
    const where = await this.#where(market, query);
    const rows = await this.prisma.tx(market).customersCustomerDirectory.findMany({
      where,
      include: INCLUDE,
      orderBy: orderBy(order.sort, order.direction),
      skip: page.offset,
      take: page.limit,
    });
    return rows.map(rowOf);
  }

  async count(market: MarketContext, query: CustomerListQuery): Promise<number> {
    return this.prisma
      .tx(market)
      .customersCustomerDirectory.count({ where: await this.#where(market, query) });
  }

  async viewCounts(
    market: MarketContext,
    now: Temporal.Instant,
  ): Promise<Readonly<Record<CustomerView, number>>> {
    const empty = { view: 'all' as const, text: null } as const;
    const counts = await Promise.all(
      CUSTOMER_VIEWS.map((view) =>
        this.count(market, {
          // The tabs count back from now and carry no day filter, so the zone plays no part.
          zone: 'UTC',
          selector: {
            ...empty,
            view,
            status: null,
            verified: null,
            joinedFrom: null,
            joinedTo: null,
            lastOrderFrom: null,
            lastOrderTo: null,
            ordersMin: null,
            ordersMax: null,
            spentMin: null,
            spentMax: null,
            group: null,
          },
          now,
        }),
      ),
    );
    return Object.fromEntries(CUSTOMER_VIEWS.map((view, index) => [view, counts[index]])) as Record<
      CustomerView,
      number
    >;
  }

  async ids(
    market: MarketContext,
    query: CustomerListQuery,
    limit: number,
  ): Promise<readonly Id<'Account'>[]> {
    const rows = await this.prisma.tx(market).customersCustomerDirectory.findMany({
      where: await this.#where(market, query),
      select: { accountId: true },
      orderBy: orderBy('joined', 'desc'),
      take: limit,
    });
    return rows.map((row) => row.accountId as Id<'Account'>);
  }

  async rowsByIds(
    market: MarketContext,
    ids: readonly Id<'Account'>[],
  ): Promise<readonly CustomerListRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).customersCustomerDirectory.findMany({
      where: { marketId: market.marketId, accountId: { in: [...ids] } },
      include: INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.accountId, rowOf(row)]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
  }

  async #where(market: MarketContext, query: CustomerListQuery): Promise<Where> {
    const { selector, now, zone } = query;
    const and: Where[] = [];

    switch (selector.view) {
      case 'all':
        break;
      case 'new':
        and.push({ signedUpAt: { gte: daysBefore(now, NEW_WINDOW_DAYS) } });
        break;
      case 'active':
        and.push({ stats: { is: { lastOrderAt: { gte: daysBefore(now, ACTIVE_WINDOW_DAYS) } } } });
        break;
      case 'inactive':
        and.push({ stats: { is: { lastOrderAt: { lt: daysBefore(now, ACTIVE_WINDOW_DAYS) } } } });
        break;
      case 'never-ordered':
        and.push({ OR: [{ stats: { is: null } }, { stats: { is: { orderCount: 0 } } }] });
        break;
      case 'disabled':
        and.push({ status: 'disabled' });
        break;
      case 'pending-deletion': {
        const pending = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
          where: { marketId: market.marketId, status: { in: ['pending', 'executing'] } },
          select: { accountId: true },
          take: PENDING_CAP,
        });
        and.push({ accountId: { in: pending.map((row) => row.accountId) } });
        break;
      }
    }

    if (selector.accountIds != null) and.push({ accountId: { in: [...selector.accountIds] } });
    if (selector.status !== null) and.push({ status: selector.status });
    if (selector.group !== null) {
      and.push({ groupMemberships: { some: { groupId: selector.group } } });
    }
    if (selector.verified !== null) and.push({ emailVerified: selector.verified });
    if (selector.joinedFrom !== null || selector.joinedTo !== null) {
      and.push({
        signedUpAt: {
          ...(selector.joinedFrom === null ? {} : { gte: startOfDay(selector.joinedFrom, zone) }),
          ...(selector.joinedTo === null ? {} : { lt: startOfNextDay(selector.joinedTo, zone) }),
        },
      });
    }
    if (selector.lastOrderFrom !== null || selector.lastOrderTo !== null) {
      and.push({
        stats: {
          is: {
            lastOrderAt: {
              ...(selector.lastOrderFrom === null
                ? {}
                : { gte: startOfDay(selector.lastOrderFrom, zone) }),
              ...(selector.lastOrderTo === null
                ? {}
                : { lt: startOfNextDay(selector.lastOrderTo, zone) }),
            },
          },
        },
      });
    }
    // A customer with no stats row has no orders and nothing spent: the counts below treat the
    // missing row as zero, so a maximum still matches them.
    and.push(...bound('orderCount', selector.ordersMin, selector.ordersMax));
    and.push(...bound('spentMinor', selector.spentMin, selector.spentMax));

    if (selector.text !== null) {
      const text = selector.text;
      const clauses: Where[] = [
        { emailLower: { startsWith: escapeLikeTerm(emailSearchKey(text)) } },
      ];
      if (Array.from(text).length >= 3) {
        clauses.push({ displayName: { contains: escapeLikeTerm(text), mode: 'insensitive' } });
      }
      and.push({ OR: clauses });
    }

    return { marketId: market.marketId, ...(and.length === 0 ? {} : { AND: and }) };
  }
}

/** A minimum and a maximum of a stats number; a missing stats row counts as zero. */
function bound(
  field: 'orderCount' | 'spentMinor',
  min: number | bigint | null,
  max: number | bigint | null,
): Where[] {
  const out: Where[] = [];
  const zero = (field === 'orderCount' ? 0 : 0n) as number | bigint;
  if (min !== null && min > zero) out.push({ stats: { is: { [field]: { gte: min } } } });
  if (max !== null) {
    out.push({ OR: [{ stats: { is: null } }, { stats: { is: { [field]: { lte: max } } } }] });
  }
  return out;
}

function orderBy(
  sort: CustomerSort,
  direction: SortDirection,
): Prisma.CustomersCustomerDirectoryOrderByWithRelationInput[] {
  const nullsLast = { sort: direction, nulls: 'last' } as const;
  const tie = { accountId: direction } as const;
  switch (sort) {
    case 'joined':
      return [{ signedUpAt: direction }, tie];
    case 'name':
      return [{ displayName: nullsLast }, tie];
    case 'email':
      return [{ emailLower: direction }, tie];
    case 'last-order':
      return [{ stats: { lastOrderAt: nullsLast } }, tie];
    // The sync writes the directory row and its stats row in one unit, so a null from the join
    // is only a transient state; Prisma cannot order nulls on these required columns.
    case 'orders':
      return [{ stats: { orderCount: direction } }, tie];
    case 'spent':
      return [{ stats: { spentMinor: direction } }, tie];
  }
}
