import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  TopicBrief,
  TopicListPage,
  TopicListQuery,
  TopicReader,
} from '../application/ports/topic.reader';
import { normaliseTopicTerm, type TopicStatus } from '../domain/topic';
import { TOPIC_INCLUDE, topicStateOf } from './prisma-topic.repository';

/** Escapes `\`, `%` and `_`, so a search term is matched as typed (LIKE patterns). */
const literal = (term: string): string => term.replace(/[\\%_]/g, (char) => `\\${char}`);

const BRIEFS_MAX = 50;

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
      const typed = literal(query.search);
      filters.push({
        OR: [
          { slug: { contains: typed.toLowerCase() } },
          { terms: { some: { term: { contains: typed, mode: 'insensitive' } } } },
          ...(key === '' ? [] : [{ terms: { some: { termKey: { contains: literal(key) } } } }]),
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
