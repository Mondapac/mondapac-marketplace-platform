import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { TopicConflict, TopicRepository } from '../application/ports/topic.repository';
import type { TopicGroup, TopicState, TopicStatus, TopicTerm } from '../domain/topic';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const UNIQUE_SLUG = 'topics_market_id_slug_key';
const UNIQUE_TERM = 'topic_terms_market_id_locale_term_key_key';

type TopicRow = Prisma.CatalogTopicGetPayload<{ include: { terms: true } }>;

/** The include every read of a topic uses: terms by locale and position (the name first). */
export const TOPIC_INCLUDE = {
  terms: { orderBy: [{ locale: 'asc' }, { position: 'asc' }] },
} as const satisfies Prisma.CatalogTopicInclude;

/** A stored topic row, with its terms, as the state of the topic. */
export function topicStateOf(row: TopicRow): TopicState {
  return {
    id: row.id as Id<'Topic'>,
    slug: row.slug,
    group: row.group as TopicGroup,
    status: row.status as TopicStatus,
    terms: row.terms.map((term): TopicTerm => ({
      locale: term.locale,
      kind: term.kind as TopicTerm['kind'],
      text: term.term,
      key: term.termKey,
    })),
    intro: row.intro,
    createdBy: row.createdBy as Id<'Account'>,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
    version: row.version,
  };
}

/**
 * {@link TopicRepository} on `catalog.topics` and `catalog.topic_terms`. Every statement runs
 * through `PrismaService.tx(market)` and carries the Market; terms are replaced as a set inside the
 * use case's unit.
 */
export class PrismaTopicRepository implements TopicRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, state: TopicState): Promise<TopicConflict | null> {
    const tx = this.prisma.tx(market);
    try {
      await tx.catalogTopic.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          slug: state.slug,
          group: state.group,
          status: state.status,
          intro: state.intro,
          createdBy: state.createdBy,
          createdAt: toDate(state.createdAt),
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
        select: { id: true },
      });
      await this.#writeTerms(market, state);
    } catch (error) {
      const conflict = this.#conflictOf(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    return null;
  }

  async findById(market: MarketContext, id: Id<'Topic'>): Promise<TopicState | null> {
    const row = await this.prisma.tx(market).catalogTopic.findFirst({
      where: { marketId: market.marketId, id },
      include: TOPIC_INCLUDE,
    });
    return row === null ? null : topicStateOf(row);
  }

  async slugTaken(market: MarketContext, slug: string): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogTopic.findFirst({
      where: { marketId: market.marketId, slug },
      select: { id: true },
    });
    return row !== null;
  }

  async takenTermKeys(
    market: MarketContext,
    terms: readonly { readonly locale: string; readonly key: string }[],
    exceptTopicId: Id<'Topic'> | null,
  ): Promise<readonly { readonly locale: string; readonly key: string }[]> {
    if (terms.length === 0) return [];
    const rows = await this.prisma.tx(market).catalogTopicTerm.findMany({
      where: {
        marketId: market.marketId,
        OR: terms.map((term) => ({ locale: term.locale, termKey: term.key })),
        ...(exceptTopicId === null ? {} : { topicId: { not: exceptTopicId } }),
      },
      select: { locale: true, termKey: true },
    });
    return rows.map((row) => ({ locale: row.locale, key: row.termKey }));
  }

  async save(
    market: MarketContext,
    state: TopicState,
    expectedVersion: number,
  ): Promise<TopicConflict | null> {
    const tx = this.prisma.tx(market);
    try {
      const { count } = await tx.catalogTopic.updateMany({
        where: { marketId: market.marketId, id: state.id, version: expectedVersion },
        data: {
          group: state.group,
          status: state.status,
          intro: state.intro,
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
      });
      if (count !== 1) throw new StaleAggregateError('topic', state.id);
      await tx.catalogTopicTerm.deleteMany({
        where: { marketId: market.marketId, topicId: state.id },
      });
      await this.#writeTerms(market, state);
    } catch (error) {
      const conflict = this.#conflictOf(error);
      if (conflict !== null) return conflict;
      throw error;
    }
    return null;
  }

  /** Inserts the terms; position 0 is the name of each locale, synonyms follow from 1. */
  async #writeTerms(market: MarketContext, state: TopicState): Promise<void> {
    if (state.terms.length === 0) return;
    const nextPosition = new Map<string, number>();
    const data = state.terms.map((term) => {
      let position = 0;
      if (term.kind === 'synonym') {
        position = nextPosition.get(term.locale) ?? 1;
        nextPosition.set(term.locale, position + 1);
      }
      return {
        marketId: market.marketId,
        tenantId: market.tenantId,
        topicId: state.id,
        locale: term.locale,
        kind: term.kind,
        term: term.text,
        termKey: term.key,
        position,
      };
    });
    await this.prisma.tx(market).catalogTopicTerm.createMany({ data });
  }

  #conflictOf(error: unknown): TopicConflict | null {
    const violated = this.prisma.violatedConstraint(error);
    if (violated === UNIQUE_SLUG) return 'topic.slug-taken';
    if (violated === UNIQUE_TERM) return 'topic.term-taken';
    return null;
  }
}
