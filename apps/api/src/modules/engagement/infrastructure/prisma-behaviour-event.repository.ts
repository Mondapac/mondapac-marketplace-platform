import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BehaviourEventRecord,
  BehaviourEventRepository,
  BehaviourRange,
  BehaviourSubject,
  BehaviourSummary,
  CartAdditionRow,
  RecentViews,
} from '../application/ports/behaviour-event.repository';
import type { BehaviourFacts } from '../domain/behaviour-event';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The columns one kind fills; every other target column stays null (the CHECKs hold it). */
function columnsOf(facts: BehaviourFacts) {
  switch (facts.kind) {
    case 'product-viewed':
      return { productId: facts.productId, offerId: facts.offerId };
    case 'category-viewed':
      return { categoryId: facts.categoryId };
    case 'search-performed':
      return { searchQuery: facts.query };
    case 'added-to-cart':
      return { offerId: facts.offerId, variantId: facts.variantId };
  }
}

/**
 * {@link BehaviourEventRepository} on `engagement.behaviour_events`, scoped by `marketId` in every
 * `where`. Rows are inserted and deleted, never changed.
 */
export class PrismaBehaviourEventRepository implements BehaviourEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(market: MarketContext, event: BehaviourEventRecord): Promise<void> {
    await this.prisma.tx(market).engagementBehaviourEvent.create({
      data: {
        id: event.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: event.subject.kind === 'account' ? event.subject.accountId : null,
        guestHash: event.subject.kind === 'guest' ? event.subject.guestHash : null,
        kind: event.facts.kind,
        ...columnsOf(event.facts),
        occurredAt: toDate(event.occurredAt),
      },
    });
  }

  async recentViews(
    market: MarketContext,
    subject: BehaviourSubject,
    limit: number,
  ): Promise<RecentViews> {
    const tx = this.prisma.tx(market);
    const who =
      subject.kind === 'account'
        ? { accountId: subject.accountId }
        : { guestHash: subject.guestHash };
    // One group per id with its latest view, newest first (ties by id, so the order is stable).
    // The subject's rows come through the (market, subject, occurred_at) index.
    const products = await tx.engagementBehaviourEvent.groupBy({
      by: ['productId'],
      where: { marketId: market.marketId, ...who, kind: 'product-viewed' },
      _max: { occurredAt: true },
      orderBy: [{ _max: { occurredAt: 'desc' } }, { productId: 'asc' }],
      take: limit,
    });
    const categories = await tx.engagementBehaviourEvent.groupBy({
      by: ['categoryId'],
      where: { marketId: market.marketId, ...who, kind: 'category-viewed' },
      _max: { occurredAt: true },
      orderBy: [{ _max: { occurredAt: 'desc' } }, { categoryId: 'asc' }],
      take: limit,
    });
    return {
      productIds: products.flatMap((row) =>
        row.productId === null ? [] : [row.productId as Id<'Product'>],
      ),
      categoryIds: categories.flatMap((row) =>
        row.categoryId === null ? [] : [row.categoryId as Id<'Category'>],
      ),
    };
  }

  async cartAdditionsOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<CartAdditionRow[]> {
    const rows = await this.prisma.tx(market).engagementBehaviourEvent.findMany({
      where: this.#additions(market, accountId, range),
      orderBy: [{ occurredAt: direction }, { id: direction }],
      skip: window.offset,
      take: window.limit,
      select: { id: true, offerId: true, variantId: true, occurredAt: true },
    });
    // `behaviour_events_shape_check` makes `offer_id` and `variant_id` NOT NULL on every
    // `added-to-cart` row, so no row is dropped here and the page agrees with
    // `countCartAdditionsOfAccount`. A NULL means the CHECK is gone: fail, never skip silently.
    return rows.map((row) => {
      if (row.offerId === null || row.variantId === null) {
        throw new Error('engagement.behaviour_events: an added-to-cart row without its offer');
      }
      return {
        id: row.id as Id<'BehaviourEvent'>,
        offerId: row.offerId as Id<'Offer'>,
        variantId: row.variantId as Id<'Variant'>,
        occurredAt: Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime()),
      };
    });
  }

  countCartAdditionsOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    range: BehaviourRange,
  ): Promise<number> {
    return this.prisma.tx(market).engagementBehaviourEvent.count({
      where: this.#additions(market, accountId, range),
    });
  }

  async summaryOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    since: Temporal.Instant,
    top: number,
  ): Promise<BehaviourSummary> {
    const tx = this.prisma.tx(market);
    const mine = { marketId: market.marketId, accountId, occurredAt: { gte: toDate(since) } };
    // Counts by kind and by category only: the search text is never selected.
    const kinds = await tx.engagementBehaviourEvent.groupBy({
      by: ['kind'],
      where: mine,
      _count: { _all: true },
    });
    const categories = await tx.engagementBehaviourEvent.groupBy({
      by: ['categoryId'],
      where: { ...mine, kind: 'category-viewed' },
      _count: { id: true },
      orderBy: [{ _count: { id: 'desc' } }, { categoryId: 'asc' }],
      take: top,
    });
    const count = (kind: string) => kinds.find((row) => row.kind === kind)?._count._all ?? 0;
    return {
      productViews: count('product-viewed'),
      categoryViews: count('category-viewed'),
      cartAdditions: count('added-to-cart'),
      topCategories: categories.flatMap((row) =>
        row.categoryId === null
          ? []
          : [{ categoryId: row.categoryId as Id<'Category'>, views: row._count.id }],
      ),
    };
  }

  #additions(market: MarketContext, accountId: Id<'Account'>, range: BehaviourRange) {
    return {
      marketId: market.marketId,
      accountId,
      kind: 'added-to-cart',
      occurredAt: {
        gte: toDate(range.from),
        ...(range.to === null ? {} : { lt: toDate(range.to) }),
      },
    };
  }

  async accountsWith(
    market: MarketContext,
    kind: 'product-viewed' | 'added-to-cart',
    range: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ): Promise<Id<'Account'>[]> {
    // One group per account (guests have no account id and are left out); ids only.
    const rows = await this.prisma.tx(market).engagementBehaviourEvent.groupBy({
      by: ['accountId'],
      where: {
        marketId: market.marketId,
        accountId: { not: null },
        kind,
        occurredAt: { gte: toDate(range.from), lt: toDate(range.to) },
      },
      orderBy: { accountId: 'asc' },
      take: limit,
    });
    return rows.flatMap((row) => (row.accountId === null ? [] : [row.accountId as Id<'Account'>]));
  }

  async deleteForAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number> {
    const { count } = await this.prisma.tx(market).engagementBehaviourEvent.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
    return count;
  }

  async purgeBefore(
    market: MarketContext,
    accountBefore: Temporal.Instant,
    guestBefore: Temporal.Instant,
  ) {
    const tx = this.prisma.tx(market);
    const accounts = await tx.engagementBehaviourEvent.deleteMany({
      where: {
        marketId: market.marketId,
        accountId: { not: null },
        occurredAt: { lt: toDate(accountBefore) },
      },
    });
    const guests = await tx.engagementBehaviourEvent.deleteMany({
      where: {
        marketId: market.marketId,
        guestHash: { not: null },
        occurredAt: { lt: toDate(guestBefore) },
      },
    });
    return { accountEvents: accounts.count, guestEvents: guests.count };
  }
}
