import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  BehaviourEventRecord,
  BehaviourEventRepository,
  BehaviourSubject,
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
