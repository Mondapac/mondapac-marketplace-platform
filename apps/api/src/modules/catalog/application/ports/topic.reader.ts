import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { TopicGroup, TopicState, TopicStatus } from '../../domain/topic';

export interface TopicListQuery {
  readonly status: TopicStatus | null;
  readonly group: TopicGroup | null;
  /** Matches a name or synonym in any locale, or the slug; case-insensitive. */
  readonly search: string | null;
  readonly afterId: Id<'Topic'> | null;
  readonly limit: number;
}

export interface TopicListPage {
  readonly items: readonly TopicState[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: Id<'Topic'> | null;
}

/** The reads of the topic package, in a read-only unit. */
export interface TopicReader {
  /** By slug, then id; keyset-paged. */
  list(market: MarketContext, query: TopicListQuery): Promise<TopicListPage>;
}

export const TOPIC_READER = Symbol('TOPIC_READER');
