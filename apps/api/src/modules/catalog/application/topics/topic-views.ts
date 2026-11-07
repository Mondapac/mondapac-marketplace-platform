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
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

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
      readonly code: 'topic.claim-word';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'access.unavailable' };

/**
 * Refuses a name, synonym, intro or slug that asserts a certification (halal, organic and the like): a
 * topic is a theme, never a claim, and it will be read by buyers on its page. Runs the claim-term
 * matcher outside any unit (it opens its own); an unavailable matcher fails closed.
 */
export async function refuseTopicClaimWords(
  matcher: ClaimTextMatcher,
  context: CallContext,
  content: { readonly terms: readonly TopicTerm[]; readonly intro: string | null },
  introLocale: string,
  slug: string | null = null,
): Promise<TopicClaimWordFailure | null> {
  const texts = [
    // The slug is read in the address: its words are matched with the hyphens as spaces.
    ...(slug === null
      ? []
      : [{ path: 'slug', locale: introLocale, text: slug.replaceAll('-', ' ') }]),
    ...content.terms.map((term, index) => ({
      path: termPath(content.terms, index),
      locale: term.locale,
      text: term.text,
    })),
    ...(content.intro === null
      ? []
      : [{ path: 'intro', locale: introLocale, text: content.intro }]),
  ];
  const answer = await matcher.match(
    context,
    texts.map(({ locale, text }) => ({ locale, text })),
  );
  if (!answer.ok || answer.value.length !== texts.length) return { code: 'access.unavailable' };
  const fields = texts
    .filter((_, index) => answer.value[index]!.length > 0)
    .map((t) => ({ path: t.path, code: 'claim-word' }));
  return fields.length > 0 ? { code: 'topic.claim-word', fields } : null;
}
