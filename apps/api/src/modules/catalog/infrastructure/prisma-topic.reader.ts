import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import { instantRangeWhere } from '../../../platform/list-query';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  TopicBrief,
  TopicListPage,
  TopicListQuery,
  TopicPageFilter,
  TopicPageQuery,
  TopicReader,
} from '../application/ports/topic.reader';
import { normaliseTopicTerm, type TopicState, type TopicStatus } from '../domain/topic';
import { likeLiteral } from './like-literal';
import { TOPIC_INCLUDE, topicStateOf } from './prisma-topic.repository';

const literal = likeLiteral;

function topicFilters(filter: TopicPageFilter): Prisma.CatalogTopicWhereInput[] {
  const filters: Prisma.CatalogTopicWhereInput[] = [];
  if (filter.status !== null) filters.push({ status: filter.status });
  if (filter.group !== null) filters.push({ group: filter.group });
  const created = instantRangeWhere({
    from: filter.createdFrom ?? null,
    to: filter.createdTo ?? null,
  });
  if (created !== undefined) filters.push({ createdAt: created });
  if (filter.search !== null) {
    const key = normaliseTopicTerm(filter.search);
    const typed = literal(filter.search);
    filters.push({
      OR: [
        { slug: { contains: typed.toLowerCase() } },
        { terms: { some: { term: { contains: typed, mode: 'insensitive' } } } },
        ...(key === '' ? [] : [{ terms: { some: { termKey: { contains: literal(key) } } } }]),
      ],
    });
  }
  return filters;
}

const BRIEFS_MAX = 50;

/** {@link TopicReader} on the topic tables; every statement carries the Market. */
export class PrismaTopicReader implements TopicReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext, query: TopicListQuery): Promise<TopicListPage> {
    const tx = this.prisma.tx(market);
    const filters = topicFilters(query);
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

  async page(market: MarketContext, query: TopicPageQuery): Promise<readonly TopicState[]> {
    const field = {
      slug: 'slug',
      status: 'status',
      group: 'group',
      created: 'createdAt',
      updated: 'updatedAt',
    }[query.sort] as 'slug' | 'status' | 'group' | 'createdAt' | 'updatedAt';
    const rows = await this.prisma.tx(market).catalogTopic.findMany({
      where: { marketId: market.marketId, AND: topicFilters(query) },
      include: TOPIC_INCLUDE,
      orderBy: [{ [field]: query.direction }, { id: query.direction }],
      skip: query.offset,
      take: query.limit,
    });
    return rows.map(topicStateOf);
  }

  async count(market: MarketContext, filter: TopicPageFilter): Promise<number> {
    return this.prisma.tx(market).catalogTopic.count({
      where: { marketId: market.marketId, AND: topicFilters(filter) },
    });
  }

  async briefsOf(market: MarketContext, ids: readonly string[]): Promise<readonly TopicBrief[]> {
    if (ids.length === 0) return [];
    if (ids.length > BRIEFS_MAX) throw new RangeError('briefsOf: too many ids');
    const rows = await this.prisma.tx(market).catalogTopic.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      select: {
        id: true,
        slug: true,
        status: true,
        terms: { where: { kind: 'name' }, select: { locale: true, term: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id as Id<'Topic'>,
      slug: row.slug,
      status: row.status as TopicStatus,
      names: Object.fromEntries(row.terms.map((term) => [term.locale, term.term])),
    }));
  }
}
