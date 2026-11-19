import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { TopicState } from '../../domain/topic';

/** Why a write was refused by a unique index. */
export type TopicConflict = 'topic.slug-taken' | 'topic.term-taken';

/**
 * The store of topics with their terms (product tags package T1). Every method runs in the open
 * unit of the use case and answers for the unit's Market.
 */
export interface TopicRepository {
  /** Inserts a new topic with its terms. */
  add(market: MarketContext, state: TopicState): Promise<TopicConflict | null>;

  findById(market: MarketContext, id: Id<'Topic'>): Promise<TopicState | null>;

  /** Whether a topic of the Market already uses this slug. */
  slugTaken(market: MarketContext, slug: string): Promise<boolean>;

  /**
   * Which of these normalised terms (by locale) another topic of the Market already uses, so the
   * use case can name the field before the unique index refuses the write.
   */
  takenTermKeys(
    market: MarketContext,
    terms: readonly { readonly locale: string; readonly key: string }[],
    exceptTopicId: Id<'Topic'> | null,
  ): Promise<readonly { readonly locale: string; readonly key: string }[]>;

  /**
   * Writes a changed topic under the version it was read at and replaces its terms. Throws
   * `StaleAggregateError` when the row changed since.
   */
  save(
    market: MarketContext,
    state: TopicState,
    expectedVersion: number,
  ): Promise<TopicConflict | null>;
}

export const TOPIC_REPOSITORY = Symbol('TOPIC_REPOSITORY');
