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

/** A topic as a product shows it: its key, its state and its names by locale. */
export interface TopicBrief {
  readonly id: Id<'Topic'>;
  readonly slug: string;
  readonly status: TopicStatus;
  readonly names: Readonly<Record<string, string>>;
}

/** The reads of the topic package, in a read-only unit. */
export interface TopicReader {
  /** By slug, then id; keyset-paged. */
  list(market: MarketContext, query: TopicListQuery): Promise<TopicListPage>;
  /**
   * The topics of this Market among `ids` (any status). An id that is unknown or belongs to another
   * Market is absent from the answer. At most 50 ids; the caller passes valid UUIDs.
   */
  briefsOf(market: MarketContext, ids: readonly string[]): Promise<readonly TopicBrief[]>;
}

export const TOPIC_READER = Symbol('TOPIC_READER');
