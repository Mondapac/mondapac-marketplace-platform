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
/** The most Offers one suggest read takes from the index, so the visibility re-check has spare. */
export const MAX_SUGGEST_CANDIDATE_OFFERS = 60;
/** The most stores one suggest read takes from the index, for the same reason. */
export const MAX_SUGGEST_CANDIDATE_STORES = 12;

/** A checked suggest query: what the index reads, all built here, none of it SQL. */
export interface SuggestQuery {
  /** Lower case, white space collapsed: the cache key and the `starts with` text. */
  readonly text: string;
  /**
   * The `to_tsquery` text: every word joined by `&`, the last one as a prefix (`:*`). Words are
   * letters and digits only, so the text has no operator and no quote and cannot be a syntax error.
   */
  readonly tsQuery: string;
  /** An `ILIKE` pattern for a name that starts with the text (`%`, `_` and `\` escaped). */
  readonly startsWith: string;
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

/**
 * Checks `q` of the suggest route (pure). Trimmed and collapsed; fewer than 2 characters, or no
 * letter or digit at all, is an empty answer (never an error, no index call). Longer than 100
 * characters, a control character or more than 8 words is `validation.failed` like the search.
 */
export function parseSuggestQuery(
  q: string | undefined,
): Result<SuggestParse, SearchValidationFailed> {
  if (q === undefined) return ok({ kind: 'empty' });
  if (typeof q !== 'string' || hasControlCharacter(q)) {
    return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'format' }] });
  }
  const text = q.trim().replace(/\s+/gu, ' ').toLowerCase();
  const length = [...text].length;
  if (length < MIN_QUERY_LENGTH) return ok({ kind: 'empty' });
  if (length > MAX_QUERY_LENGTH) {
    return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-long' }] });
  }
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > MAX_OR_TERMS) {
    return err({ code: 'validation.failed', fields: [{ path: 'q', code: 'too-many-terms' }] });
  }
  if (words.length === 0) return ok({ kind: 'empty' });
  const tsQuery = words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word));
  return ok({
    kind: 'query',
    query: {
      text,
      tsQuery: tsQuery.join(' & '),
      startsWith: `${escapeLike(text)}%`,
      contains: `%${escapeLike(text)}%`,
    },
  });
}
