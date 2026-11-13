import type { IdGenerator, MarketContext } from '@mondapac/shared-kernel';
import { TOPIC_SLUG_MAX, suggestTopicSlug } from '../../domain/topic';
import type { TopicRepository } from '../ports/topic.repository';

const MAX_SLUG_PROBES = 50;

/**
 * A free slug for a new topic: the one given when it is free (`null` when it is taken), else the
 * form the default-locale name suggests, with a numeric suffix when that is taken, and last a
 * suffix from a fresh id. A slug taken between this read and the write is refused by the unique
 * index. Runs inside the use case's unit.
 */
export async function freeTopicSlug(
  market: MarketContext,
  topics: TopicRepository,
  ids: IdGenerator,
  given: string | null,
  name: string,
): Promise<string | null> {
  if (given !== null) return (await topics.slugTaken(market, given)) ? null : given;
  const base = suggestTopicSlug(name);
  for (let n = 1; n <= MAX_SLUG_PROBES; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${base.slice(0, TOPIC_SLUG_MAX - suffix.length).replace(/-+$/u, '')}${suffix}`;
    if (!(await topics.slugTaken(market, candidate))) return candidate;
  }
  return `${base.slice(0, 31).replace(/-+$/u, '')}-${ids.next<'Topic'>().slice(-8)}`;
}
