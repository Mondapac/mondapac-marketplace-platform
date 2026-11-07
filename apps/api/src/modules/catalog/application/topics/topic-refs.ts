import type { MarketContext } from '@mondapac/shared-kernel';
import type { TopicStatus } from '../../domain/topic';
import type { TopicBrief, TopicReader } from '../ports/topic.reader';

/** A topic as a product read shows it: its key, its state and a name for display. */
export interface TopicRef {
  readonly id: string;
  readonly slug: string;
  readonly status: TopicStatus;
  /** The name in the Market's default locale, else any locale; null when it has none. */
  readonly name: string | null;
  /** Every name by locale, for a panel that shows another language. */
  readonly names: Readonly<Record<string, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most ids one lookup takes (a product holds 10; three revisions are read together). */
const LOOKUP_MAX = 50;

export function refOf(brief: TopicBrief, defaultLocale: string): TopicRef {
  const locales = Object.keys(brief.names).sort();
  const name =
    brief.names[defaultLocale] ?? (locales[0] === undefined ? null : brief.names[locales[0]]);
  return {
    id: brief.id,
    slug: brief.slug,
    status: brief.status,
    name: name ?? null,
    names: brief.names,
  };
}

/** A draft's `topicIds` as a list of well-formed ids; anything malformed reads as none. */
export function draftTopicIds(content: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = content?.['topicIds'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && UUID.test(item))
    .map((item) => item.toLowerCase());
}

/**
 * The topics of this Market among `ids`, by id, in one read. An id of another Market or one that
 * does not exist is absent (never an error). A malformed id is dropped before the query.
 */
export async function topicRefsOf(
  reader: Pick<TopicReader, 'briefsOf'> | undefined,
  market: MarketContext,
  ids: Iterable<string>,
  defaultLocale: string,
): Promise<Map<string, TopicRef>> {
  const unique = [...new Set(ids)].filter((id) => UUID.test(id)).slice(0, LOOKUP_MAX);
  if (reader === undefined || unique.length === 0) return new Map();
  const briefs = await reader.briefsOf(market, unique);
  return new Map(briefs.map((brief) => [brief.id as string, refOf(brief, defaultLocale)]));
}
