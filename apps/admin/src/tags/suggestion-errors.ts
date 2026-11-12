import type { ApiFailure } from '../api/client.ts';

/** What the screen does with a refused decision. */
export interface SuggestionProblem {
  /** A message key under `tags.suggestions.error`. */
  readonly key: string;
  /** The suggestion moved on or was decided: the list is read again and told above the list. */
  readonly reload: boolean;
  /** The card should offer the Map action (the name or slug is taken). */
  readonly focusMap: boolean;
  /** Field names the API refused (`name`, `slug`, `group`, ...). */
  readonly fields: readonly string[];
}

const BY_CODE: Readonly<Record<string, { key: string; reload?: boolean; focusMap?: boolean }>> = {
  'validation.failed': { key: 'invalid' },
  'suggestion.label-invalid': { key: 'invalid' },
  'suggestion.reason-invalid': { key: 'invalid' },
  'topic.claim-word': { key: 'claim-word' },
  'topic.locale-uncheckable': { key: 'locale-uncheckable' },
  'topic.term-taken': { key: 'term-taken', focusMap: true },
  'topic.slug-taken': { key: 'term-taken', focusMap: true },
  'suggestion.topic-invalid': { key: 'topic-invalid' },
  'suggestion.stale': { key: 'stale', reload: true },
  'suggestion.not-open': { key: 'stale', reload: true },
  'suggestion.not-found': { key: 'stale', reload: true },
  'access.denied': { key: 'denied' },
  'request.csrf': { key: 'csrf' },
  'request.throttled': { key: 'throttled' },
};

export function suggestionProblemOf(failure: ApiFailure): SuggestionProblem {
  const known = BY_CODE[failure.code];
  const key =
    known?.key ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  return {
    key,
    reload: known?.reload ?? false,
    focusMap: known?.focusMap ?? false,
    fields: (failure.details?.fields ?? []).map((field) => field.path.split('.')[0] ?? field.path),
  };
}
