import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { TopicTerm } from '../../domain/topic';
import type { TopicRepository } from '../ports/topic.repository';
import { termPath } from './topic-views';

export interface TopicTermTaken {
  readonly code: 'topic.term-taken';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/**
 * The terms of a create or edit that another topic of the Market already uses (on the normalised
 * form, per locale), named by field. Runs inside the use case's unit; the unique index is the
 * backstop for a race.
 */
export async function termsTakenElsewhere(
  market: MarketContext,
  terms: readonly TopicTerm[],
  topics: TopicRepository,
  exceptTopicId: Id<'Topic'> | null,
): Promise<TopicTermTaken | null> {
  const taken = await topics.takenTermKeys(
    market,
    terms.map((term) => ({ locale: term.locale, key: term.key })),
    exceptTopicId,
  );
  if (taken.length === 0) return null;
  const hit = new Set(taken.map((t) => `${t.locale}\u0000${t.key}`));
  const fields = terms
    .map((term, index) => ({ term, index }))
    .filter(({ term }) => hit.has(`${term.locale}\u0000${term.key}`))
    .map(({ index }) => ({ path: termPath(terms, index), code: 'taken' }));
  return { code: 'topic.term-taken', fields };
}
