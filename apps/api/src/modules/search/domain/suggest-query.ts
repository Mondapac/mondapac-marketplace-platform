import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  MAX_OR_TERMS,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  type SearchValidationFailed,
} from './search-query';

/** How many products and stores the suggestion panel shows. */
export const MAX_SUGGEST_PRODUCTS = 5;
export const MAX_SUGGEST_STORES = 3;
/**
 * The most Offer candidates (one per product) one suggest read takes from the index: 5 are shown, the
 * rest are spare for the visibility re-check, and the cache holds no more than this.
 */
export const MAX_SUGGEST_CANDIDATE_OFFERS = 15;
/** The most store candidates one suggest read takes (3 are shown). */
export const MAX_SUGGEST_CANDIDATE_STORES = 6;
/** The suggest total counts at most this many products; beyond it `totalIsCapped` is true. */
export const MAX_SUGGEST_SCOPE_PRODUCTS = 1000;

/** A checked suggest query: what the index reads, all built here from the words, none of it SQL. */
export interface SuggestQuery {
  /** The words (letters, digits and their combining marks), NFC, lower case. */
  readonly words: readonly string[];
  /** The words joined by one space: the canonical text of the query. */
  readonly text: string;
  /**
   * The `to_tsquery` text: every word joined by `&`, the last one as a prefix (`:*`) when it has at
   * least 2 letters or digits. Words hold no operator, quote or space, so it cannot be a syntax error.
   */
  readonly tsQuery: string;
  /** The same words, every lexeme restricted to weight A (the name): "the name has every word". */
  readonly nameQuery: string;
  /** An `ILIKE` pattern for a name that starts with the text (`%`, `_` and `\` escaped). */
  readonly startsWith: string;
  /** An `ILIKE` pattern for a name that starts with the first word. */
  readonly firstWordStarts: string;
  /** An `ILIKE` pattern for a name that contains the text. */
  readonly contains: string;
}

/** The answer of the parse: nothing to ask (too short or no word), or a query. */
export type SuggestParse =
  { readonly kind: 'empty' } | { readonly kind: 'query'; query: SuggestQuery };

const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, '\\$&');

/** Control characters (C0, DEL, C1) never belong in a search text (the same rule as the search). */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** A word: starts with a letter or digit, then letters, digits and combining marks. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/**
 * Checks `q` of the suggest route (pure). NFC, trimmed, lower case. The 2-character rule counts
 * letters and digits only (not punctuation, white space or zero-width characters): fewer is an empty
 * answer (never an error, no index call). Longer than 100 characters, a control character or more
 * than 8 words is `validation.failed` like the search. The last word is a prefix only when it has at
 * least 2 letters or digits (a single character is matched as a whole lexeme).
 */
export function parseSuggestQuery(
  q: string | undefined,
): Result<SuggestParse, SearchValidationFailed> {
  if (q === undefined) return ok({ kind: 'empty' });
  if (typeof q !== 'string' || hasControlCharacter(q)) {
    return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'format' }] });
  }
  const text = q.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
  if ([...text].length > MAX_QUERY_LENGTH) {
    return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-long' }] });
  }
  if ((text.match(LETTER_OR_DIGIT) ?? []).length < MIN_QUERY_LENGTH) return ok({ kind: 'empty' });
  const words = text.match(WORD) ?? [];
  if (words.length > MAX_OR_TERMS) {
    return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-many-terms' }] });
  }
  const last = words.length - 1;
  const prefixed = (word: string, index: number, weight: string): string =>
    index === last && (word.match(LETTER_OR_DIGIT) ?? []).length >= 2
      ? `${word}:*${weight}`
      : `${word}${weight === '' ? '' : `:${weight}`}`;
  const canonical = words.join(' ');
  return ok({
    kind: 'query',
    query: {
      words,
      text: canonical,
      tsQuery: words.map((word, index) => prefixed(word, index, '')).join(' & '),
      nameQuery: words.map((word, index) => prefixed(word, index, 'A')).join(' & '),
      startsWith: `${escapeLike(canonical)}%`,
      firstWordStarts: `${escapeLike(words[0]!)}%`,
      contains: `%${escapeLike(canonical)}%`,
    },
  });
}
