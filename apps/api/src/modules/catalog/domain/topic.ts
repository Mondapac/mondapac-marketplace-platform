import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// The topic entity (product tags package T1; john's decisions of 24 Oct 2026). A topic is a
// shopping theme such as Ramadan, Persian cuisine or BBQ that groups products across categories.
// The list is curated by an admin per Market; sellers and admins later pick topics for a product
// (package T2). In the panels and to buyers it is called a "tag"; in code it is a `topic`, because
// `tag` already names the certification tag on an Offer (ADR-0028), which a topic never is.
//
//   active <---> archived
//
// The slug is fixed at creation: it is the topic's key and the address of its future page
// (/t/<slug>, package T4). Names and synonyms are "terms": every term is unique per Market and
// locale on its normalised form, so "BBQ" and "bbq" are one topic and a synonym cannot point at
// two topics. A name or synonym that asserts a certification (halal, organic and the like) is
// refused by the use cases through the claim-term matcher.

export const TOPIC_STATUSES = ['active', 'archived'] as const;
export type TopicStatus = (typeof TOPIC_STATUSES)[number];

/** How the admin list is grouped: an occasion (Ramadan), a cuisine (Persian), a use (BBQ). */
export const TOPIC_GROUPS = ['occasion', 'cuisine', 'use'] as const;
export type TopicGroup = (typeof TOPIC_GROUPS)[number];

export const TOPIC_SLUG_MAX = 40;
export const TOPIC_TERM_MIN = 2;
export const TOPIC_TERM_MAX = 40;
/** The most synonyms one topic may carry in one locale. */
export const TOPIC_SYNONYMS_MAX = 10;

/** The most topics one product carries (product tags T2); the database position CHECK repeats it. */
export const MAX_TOPICS_PER_PRODUCT = 10;
/** The intro text of the topic page (package T4); written by a person. */
export const TOPIC_INTRO_MAX = 1000;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/**
 * Control, format and separator characters other than a plain space: never part of a term. The
 * zero-width non-joiner (U+200C) is allowed, because Persian spelling needs it.
 */
const HIDDEN_OR_CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;
const ZWNJ = /‌/gu;
/** A term is a label, never an address. */
const LINK_LIKE = /(:\/\/|www\.|https?:|\.(com|net|org|au|io|shop)\b)/iu;

export const isTopicSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= TOPIC_SLUG_MAX && SLUG_PATTERN.test(value);

/** Inner runs of whitespace become one space and the ends are trimmed. */
export const tidyTopicText = (raw: string): string => raw.replace(/\s+/gu, ' ').trim();

/**
 * The normalised form of a topic term: the key two terms are compared on, for uniqueness now and
 * for search later (package T3). Written for Persian and Arabic as well as English, so data does
 * not have to be rebuilt when a locale is added:
 *
 * 1. Unicode NFKC, then the Arabic letter forms Persian writes differently: ي and ى to ی, ك to ک,
 *    أ إ آ ٱ to ا, ة to ه, ؤ to و, ئ to ی.
 * 2. Arabic diacritics (harakat, superscript alef) and the tatweel are removed.
 * 3. Persian and Arabic digits become ASCII digits.
 * 4. The zero-width non-joiner and every punctuation or symbol character become a space; "&" is
 *    read as "and".
 * 5. Lower case, one space between words, trimmed.
 *
 * Plural and singular are left alone: the text search configuration of the Market handles them.
 */
export function normaliseTopicTerm(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[يى]/gu, 'ی')
    .replace(/ك/gu, 'ک')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ة/gu, 'ه')
    .replace(/ؤ/gu, 'و')
    .replace(/ئ/gu, 'ی')
    .replace(/[ً-ٰٟـ]/gu, '')
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/&/gu, ' and ')
    .replace(ZWNJ, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The slug a name suggests: lower case ASCII words joined by hyphens; `topic` when none is left. */
export function suggestTopicSlug(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/&/gu, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, TOPIC_SLUG_MAX)
    .replace(/-+$/gu, '');
  return words === '' ? 'topic' : words;
}

export interface TopicFieldProblem {
  readonly path: string;
  readonly code: string;
}

/** One name or synonym of a topic in one locale, with its normalised key. */
export interface TopicTerm {
  readonly locale: string;
  readonly kind: 'name' | 'synonym';
  readonly text: string;
  readonly key: string;
}

/** The editable content of a topic, validated. Terms by locale, the name first, in input order. */
export interface TopicContent {
  readonly group: TopicGroup;
  readonly terms: readonly TopicTerm[];
  readonly intro: string | null;
}

export interface TopicLocales {
  /** The locale whose name is required. */
  readonly required: string;
  readonly supported: readonly string[];
}

/** A term's text checked alone: tidy, 2 to 40 characters, no hidden character, no link. */
function parseTerm(raw: string): { text: string; key: string } | { problem: string } | null {
  const text = tidyTopicText(raw);
  if (text === '') return null;
  if (HIDDEN_OR_CONTROL.test(text.replace(ZWNJ, ''))) return { problem: 'chars' };
  if (LINK_LIKE.test(text)) return { problem: 'link' };
  if (text.length > TOPIC_TERM_MAX) return { problem: 'too-long' };
  const key = normaliseTopicTerm(text);
  if (key.length < TOPIC_TERM_MIN || text.length < TOPIC_TERM_MIN) return { problem: 'too-short' };
  return { text, key };
}

/**
 * Validates the content of a create or an edit. Every field is judged and the problems come back
 * together.
 *
 * - `group`: one of {@link TOPIC_GROUPS}.
 * - `names`: an object of locale to text. The required locale must be present and every locale
 *   supported; a name is 2 to 40 characters, without hidden characters or a link.
 * - `synonyms`: an optional object of locale to a list of texts (each checked like a name), at
 *   most 10 per locale, only in a locale that has a name. A synonym equal to a name or to another
 *   synonym of the topic (on the normalised form) is a `duplicate`.
 * - `intro`: optional text up to 1000 characters.
 */
export function parseTopicContent(
  input: {
    readonly group?: unknown;
    readonly names?: unknown;
    readonly synonyms?: unknown;
    readonly intro?: unknown;
  },
  locales: TopicLocales,
): Result<TopicContent, readonly TopicFieldProblem[]> {
  const problems: TopicFieldProblem[] = [];
  const terms: TopicTerm[] = [];

  let group: TopicGroup = 'use';
  if (
    typeof input.group !== 'string' ||
    !(TOPIC_GROUPS as readonly string[]).includes(input.group)
  ) {
    problems.push({ path: 'group', code: input.group === undefined ? 'required' : 'unknown' });
  } else {
    group = input.group as TopicGroup;
  }

  const supported = (locale: string): boolean =>
    LOCALE_PATTERN.test(locale) && locales.supported.includes(locale);

  const rawNames = input.names;
  const named = new Set<string>();
  if (typeof rawNames !== 'object' || rawNames === null || Array.isArray(rawNames)) {
    problems.push({ path: 'names', code: 'type' });
  } else {
    for (const locale of Object.keys(rawNames).sort()) {
      const path = `names.${locale.slice(0, 16)}`;
      const raw = (rawNames as Record<string, unknown>)[locale];
      if (!supported(locale)) {
        problems.push({ path, code: 'locale-unsupported' });
        continue;
      }
      if (typeof raw !== 'string') {
        problems.push({ path, code: 'type' });
        continue;
      }
      const term = parseTerm(raw);
      if (term === null) continue; // an empty name is the same as no name for that locale
      if ('problem' in term) problems.push({ path, code: term.problem });
      else {
        named.add(locale);
        terms.push({ locale, kind: 'name', text: term.text, key: term.key });
      }
    }
    const requiredPath = `names.${locales.required}`;
    if (!named.has(locales.required) && !problems.some((p) => p.path === requiredPath)) {
      problems.push({ path: requiredPath, code: 'required' });
    }
  }

  const rawSynonyms = input.synonyms;
  if (rawSynonyms !== undefined && rawSynonyms !== null) {
    if (typeof rawSynonyms !== 'object' || Array.isArray(rawSynonyms)) {
      problems.push({ path: 'synonyms', code: 'type' });
    } else {
      for (const locale of Object.keys(rawSynonyms).sort()) {
        const path = `synonyms.${locale.slice(0, 16)}`;
        const list = (rawSynonyms as Record<string, unknown>)[locale];
        if (!supported(locale)) {
          problems.push({ path, code: 'locale-unsupported' });
          continue;
        }
        if (!Array.isArray(list)) {
          problems.push({ path, code: 'type' });
          continue;
        }
        if (list.length > TOPIC_SYNONYMS_MAX) {
          problems.push({ path, code: 'too-many' });
          continue;
        }
        if (list.length > 0 && !named.has(locale)) {
          problems.push({ path, code: 'name-missing' });
          continue;
        }
        const seen = new Set(terms.filter((t) => t.locale === locale).map((t) => t.key));
        list.forEach((raw: unknown, index) => {
          const itemPath = `${path}.${index}`;
          if (typeof raw !== 'string') {
            problems.push({ path: itemPath, code: 'type' });
            return;
          }
          const term = parseTerm(raw);
          if (term === null) return;
          if ('problem' in term) {
            problems.push({ path: itemPath, code: term.problem });
          } else if (seen.has(term.key)) {
            problems.push({ path: itemPath, code: 'duplicate' });
          } else {
            seen.add(term.key);
            terms.push({ locale, kind: 'synonym', text: term.text, key: term.key });
          }
        });
      }
    }
  }

  let intro: string | null = null;
  if (input.intro !== undefined && input.intro !== null) {
    if (typeof input.intro !== 'string') {
      problems.push({ path: 'intro', code: 'type' });
    } else {
      // Paragraphs are kept: only the ends are trimmed and runs of spaces inside a line closed.
      const tidy = input.intro
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
      if (tidy.length > TOPIC_INTRO_MAX) problems.push({ path: 'intro', code: 'too-long' });
      else if (HIDDEN_OR_CONTROL.test(tidy.replace(/\n/gu, '').replace(ZWNJ, '')))
        problems.push({ path: 'intro', code: 'chars' });
      else if (LINK_LIKE.test(tidy)) problems.push({ path: 'intro', code: 'link' });
      else if (tidy !== '') intro = tidy;
    }
  }

  if (problems.length > 0) return err(problems);
  return ok({ group, terms: orderTerms(terms), intro });
}

/** Terms in their stored order: by locale, the name first, synonyms in the order given. */
export function orderTerms(terms: readonly TopicTerm[]): TopicTerm[] {
  return terms
    .map((term, index) => ({ term, index }))
    .sort(
      (a, b) =>
        a.term.locale.localeCompare(b.term.locale) ||
        (a.term.kind === b.term.kind ? 0 : a.term.kind === 'name' ? -1 : 1) ||
        a.index - b.index,
    )
    .map(({ term }) => term);
}

/** A stored topic as the use cases see it. */
export interface TopicState {
  readonly id: Id<'Topic'>;
  readonly slug: string;
  readonly group: TopicGroup;
  readonly status: TopicStatus;
  readonly terms: readonly TopicTerm[];
  readonly intro: string | null;
  readonly createdBy: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/** The state of a new, active topic at version 1. */
export function newTopic(input: {
  readonly id: Id<'Topic'>;
  readonly slug: string;
  readonly content: TopicContent;
  readonly createdBy: Id<'Account'>;
  readonly now: Temporal.Instant;
}): TopicState {
  return {
    id: input.id,
    slug: input.slug,
    group: input.content.group,
    status: 'active',
    terms: input.content.terms,
    intro: input.content.intro,
    createdBy: input.createdBy,
    createdAt: input.now,
    updatedAt: input.now,
    version: 1,
  };
}
