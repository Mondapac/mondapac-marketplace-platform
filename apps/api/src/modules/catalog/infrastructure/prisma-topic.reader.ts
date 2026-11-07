import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { TopicListPage, TopicListQuery, TopicReader } from '../application/ports/topic.reader';
import { normaliseTopicTerm } from '../domain/topic';
import { TOPIC_INCLUDE, topicStateOf } from './prisma-topic.repository';

/** {@link TopicReader} on the topic tables; every statement carries the Market. */
export class PrismaTopicReader implements TopicReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext, query: TopicListQuery): Promise<TopicListPage> {
    const tx = this.prisma.tx(market);
    const filters: Prisma.CatalogTopicWhereInput[] = [];
    if (query.status !== null) filters.push({ status: query.status });
    if (query.group !== null) filters.push({ group: query.group });
    if (query.search !== null) {
      const key = normaliseTopicTerm(query.search);
      filters.push({
        OR: [
          { slug: { contains: query.search.toLowerCase() } },
          { terms: { some: { term: { contains: query.search, mode: 'insensitive' } } } },
          ...(key === '' ? [] : [{ terms: { some: { termKey: { contains: key } } } }]),
        ],
      });
    }
    if (query.afterId !== null) {
      // Keyset by (slug, id): the page starts after the row the cursor names.
      const cursor = await tx.catalogTopic.findFirst({
        where: { marketId: market.marketId, id: query.afterId },
        select: { slug: true },
      });
      if (cursor === null) return { items: [], nextAfterId: null };
      filters.push({
        OR: [{ slug: { gt: cursor.slug } }, { slug: cursor.slug, id: { gt: query.afterId } }],
      });
    }
    const rows = await tx.catalogTopic.findMany({
      where: { marketId: market.marketId, AND: filters },
      include: TOPIC_INCLUDE,
      orderBy: [{ slug: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(topicStateOf),
      nextAfterId: rows.length > query.limit ? (page[page.length - 1]!.id as Id<'Topic'>) : null,
    };
  }
}
