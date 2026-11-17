/** The sorts of a seller's own suggestion list. */
export const OWN_SUGGESTION_SORTS = ['created', 'status', 'label'] as const;
export type OwnSuggestionSort = (typeof OWN_SUGGESTION_SORTS)[number];

/** What narrows a seller's own suggestions: a status and a search in the label (contains). */
export interface OwnSuggestionsFilter<Status extends string> {
  readonly status: Status | null;
  readonly text: string | null;
}

/** One numbered page of a seller's own suggestions. */
export interface OwnSuggestionsPage<Status extends string> extends OwnSuggestionsFilter<Status> {
  readonly sort: OwnSuggestionSort;
  readonly direction: 'asc' | 'desc';
  readonly offset: number;
  readonly limit: number;
}
