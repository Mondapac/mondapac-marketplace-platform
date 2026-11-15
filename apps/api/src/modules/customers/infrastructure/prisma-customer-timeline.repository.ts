import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CustomerTimelineRepository,
  TimelineQuery,
} from '../application/ports/customer-timeline.repository';
import {
  TIMELINE_KINDS,
  type TimelineEntry,
  type TimelineKind,
  type TimelineRefType,
} from '../domain/customer-timeline';

const instant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const date = (value: Temporal.Instant): Date => new Date(value.epochMilliseconds);

const whereOf = (
  market: MarketContext,
  query: TimelineQuery,
): Prisma.CustomersCustomerTimelineEntryWhereInput => ({
  marketId: market.marketId,
  accountId: query.accountId,
  ...(query.kinds === null ? {} : { kind: { in: [...query.kinds] } }),
  ...(query.from === null && query.to === null
    ? {}
    : {
        occurredAt: {
          ...(query.from === null ? {} : { gte: date(query.from) }),
          ...(query.to === null ? {} : { lt: date(query.to) }),
        },
      }),
});

/** {@link CustomerTimelineRepository} on `customers.customer_timeline`; no raw SQL. */
export class PrismaCustomerTimelineRepository implements CustomerTimelineRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    market: MarketContext,
    entry: TimelineEntry,
    at: Temporal.Instant,
    options: { readonly known?: boolean } = {},
  ) {
    return (await this.#insert(market, [entry], at, options.known === true)) === 1;
  }

  recordMany(
    market: MarketContext,
    entries: readonly TimelineEntry[],
    at: Temporal.Instant,
  ): Promise<number> {
    return this.#insert(market, entries, at, false);
  }

  async hasCustomer(market: MarketContext, accountId: Id<'Account'>): Promise<boolean> {
    const row = await this.prisma.tx(market).customersCustomerDirectory.findFirst({
      where: { marketId: market.marketId, accountId },
      select: { accountId: true },
    });
    return row !== null;
  }

  async #insert(
    market: MarketContext,
    entries: readonly TimelineEntry[],
    at: Temporal.Instant,
    known: boolean,
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const tx = this.prisma.tx(market);
    // No entry for a customer the module does not know (unknown, erased): the read models decide.
    let ids: Set<string> | null = null;
    if (!known) {
      const rows = await tx.customersCustomerDirectory.findMany({
        where: {
          marketId: market.marketId,
          accountId: { in: [...new Set(entries.map((entry) => entry.accountId))] },
        },
        select: { accountId: true },
      });
      ids = new Set(rows.map((row) => row.accountId));
    }
    const data = entries
      .filter((entry) => ids === null || ids.has(entry.accountId))
      .map((entry) => ({
        id: entry.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: entry.accountId,
        occurredAt: date(entry.occurredAt),
        kind: entry.kind,
        refType: entry.ref?.type ?? null,
        refId: entry.ref?.id ?? null,
        actorAccountId: entry.actorAccountId,
        detail: entry.detail,
        sourceEventId: entry.sourceEventId,
        recordedAt: date(at),
      }));
    if (data.length === 0) return 0;
    // A repeated delivery of the same event is a duplicate of the (account, source event) key.
    const { count } = await tx.customersCustomerTimelineEntry.createMany({
      data,
      skipDuplicates: true,
    });
    return count;
  }

  async page(
    market: MarketContext,
    query: TimelineQuery,
    order: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly TimelineEntry[]> {
    const rows = await this.prisma.tx(market).customersCustomerTimelineEntry.findMany({
      where: whereOf(market, query),
      orderBy: [{ occurredAt: order }, { id: order }],
      skip: window.offset,
      take: window.limit,
    });
    return rows.flatMap((row) => {
      const kind = TIMELINE_KINDS.find((known) => known === row.kind);
      // A kind this build does not know (written by a newer one) is left out, not guessed.
      if (kind === undefined) return [];
      return [
        {
          id: row.id as Id<'CustomerTimelineEntry'>,
          accountId: row.accountId as Id<'Account'>,
          occurredAt: instant(row.occurredAt),
          kind: kind satisfies TimelineKind,
          ref:
            row.refType === null || row.refId === null
              ? null
              : { type: row.refType as TimelineRefType, id: row.refId },
          actorAccountId: row.actorAccountId as Id<'Account'> | null,
          detail: row.detail,
          sourceEventId: row.sourceEventId,
        },
      ];
    });
  }

  count(market: MarketContext, query: TimelineQuery): Promise<number> {
    return this.prisma
      .tx(market)
      .customersCustomerTimelineEntry.count({ where: whereOf(market, query) });
  }
}
