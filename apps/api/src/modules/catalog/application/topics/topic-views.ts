import { ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  TOPIC_GROUPS,
  TOPIC_STATUSES,
  type TopicGroup,
  type TopicState,
  type TopicStatus,
  type TopicTerm,
} from '../../domain/topic';
import { invalid, type ValidationFailure } from '../business-activities/business-activity-views';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import { MAX_MATCH_TEXTS, type ClaimTextMatcher } from '../ports/claim-text-matcher';

/** The language of a slug's words. */
const SLUG_LOCALE = 'en';

export {
  adminAccountOf,
  closedInput,
  invalid,
  invalidFields,
  versionOf,
  type ValidationFailure,
} from '../business-activities/business-activity-views';

export const TOPIC_PAGE_DEFAULT = 25;
export const TOPIC_PAGE_MAX = 100;
export const TOPIC_SEARCH_MAX = 80;

/** A topic as the admin routes show it. Names by locale; synonyms by locale, in order. */
export interface TopicView {
  readonly id: string;
  readonly slug: string;
  readonly group: TopicGroup;
  readonly status: TopicStatus;
  readonly names: Readonly<Record<string, string>>;
  readonly synonyms: Readonly<Record<string, readonly string[]>>;
  readonly intro: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The version a change must name. */
  readonly version: number;
}

export function viewOf(state: TopicState): TopicView {
  const names: Record<string, string> = {};
  const synonyms: Record<string, string[]> = {};
  for (const term of state.terms) {
    if (term.kind === 'name') names[term.locale] = term.text;
    else (synonyms[term.locale] ??= []).push(term.text);
  }
  return {
    id: state.id,
    slug: state.slug,
    group: state.group,
    status: state.status,
    names,
    synonyms,
    intro: state.intro,
    createdAt: state.createdAt.toString(),
    updatedAt: state.updatedAt.toString(),
    version: state.version,
  };
}

export function topicIdOf(raw: unknown, path: string): Result<Id<'Topic'>, ValidationFailure> {
  const parsed = typeof raw === 'string' ? parseId<'Topic'>(raw) : null;
  if (parsed === null || !parsed.ok) return invalid(path, 'format');
  return ok(parsed.value);
}

export function topicStatusOf(raw: unknown, path: string): Result<TopicStatus, ValidationFailure> {
  if (typeof raw !== 'string' || !(TOPIC_STATUSES as readonly string[]).includes(raw)) {
    return invalid(path, 'unknown');
  }
  return ok(raw as TopicStatus);
}

export function topicGroupOf(raw: unknown, path: string): Result<TopicGroup, ValidationFailure> {
  if (typeof raw !== 'string' || !(TOPIC_GROUPS as readonly string[]).includes(raw)) {
    return invalid(path, 'unknown');
  }
  return ok(raw as TopicGroup);
}

/** The field path of a term, as the request named it. */
export function termPath(terms: readonly TopicTerm[], index: number): string {
  const term = terms[index]!;
  if (term.kind === 'name') return `names.${term.locale}`;
  const before = terms
    .slice(0, index)
    .filter((t) => t.locale === term.locale && t.kind === 'synonym').length;
  return `synonyms.${term.locale}.${before}`;
}

export type TopicClaimWordFailure =
  | {
      readonly code: 'topic.claim-word' | 'topic.locale-uncheckable';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.unavailable' };

/**
 * Refuses a name, synonym, intro or slug that asserts a certification (halal, organic and the
 * like): a topic is a theme, never a claim, and buyers read it on its page. Fails closed like the
 * category check (`refuseClaimTexts`): a text in a locale the Market's claim vocabulary does not
 * cover is `topic.locale-uncheckable`; an unreadable vocabulary, a matcher that throws or answers
 * in the wrong shape is `access.unavailable`; a hit is `topic.claim-word` with the paths, never the
 * words. Texts go in batches of the matcher's limit. Call it with no unit of work open: the
 * certification facade opens its own.
 */
export async function refuseTopicClaimWords(
  deps: { readonly matcher: ClaimTextMatcher; readonly claimLocales: ClaimTermLocales },
  context: CallContext,
  content: { readonly terms: readonly TopicTerm[]; readonly intro: string | null },
  defaultLocale: string,
  slug: string | null = null,
): Promise<TopicClaimWordFailure | null> {
  const covered = await deps.claimLocales.covered(context).catch(() => null);
  if (covered === null || !covered.ok) {
    return { code: 'access.unavailable' };
  }
  // The slug is ASCII words: it is checked with the Market's English vocabulary (a vocabulary is
  // kept per full locale, such as en-AU), or with the default locale's when there is none.
  const english =
    covered.value.find((locale) => locale === SLUG_LOCALE) ??
    covered.value.find((locale) => locale.split('-')[0] === SLUG_LOCALE) ??
    defaultLocale;
  const places = [
    ...(slug === null ? [] : [{ path: 'slug', locale: english, text: slug.replaceAll('-', ' ') }]),
    ...content.terms.map((term, index) => ({
      path: termPath(content.terms, index),
      locale: term.locale,
      text: term.text,
    })),
    ...(content.intro === null
      ? []
      : [{ path: 'intro', locale: defaultLocale, text: content.intro }]),
  ];
  const uncheckable = places
    .filter((place) => !covered.value.includes(place.locale))
    .map((place) => ({ path: place.path, code: 'locale-uncheckable' }));
  if (uncheckable.length > 0) return { code: 'topic.locale-uncheckable', fields: uncheckable };
  const found: { path: string; code: string }[] = [];
  for (let from = 0; from < places.length; from += MAX_MATCH_TEXTS) {
    const batch = places.slice(from, from + MAX_MATCH_TEXTS);
    let answer: Awaited<ReturnType<ClaimTextMatcher['match']>>;
    try {
      answer = await deps.matcher.match(
        context,
        batch.map(({ locale, text }) => ({ locale, text })),
      );
    } catch {
      return { code: 'access.unavailable' };
    }
    if (!answer.ok || !Array.isArray(answer.value) || answer.value.length !== batch.length) {
      return { code: 'access.unavailable' };
    }
    for (const [index, place] of batch.entries()) {
      const hits: unknown = answer.value[index];
      if (!Array.isArray(hits)) return { code: 'access.unavailable' };
      if (hits.length > 0) found.push({ path: place.path, code: 'claim-word' });
    }
  }
  return found.length > 0 ? { code: 'topic.claim-word', fields: found } : null;
}
