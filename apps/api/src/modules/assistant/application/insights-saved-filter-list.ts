import { closedListPayloadParser, type ClosedFilterRule, type ListDefinition } from '../../lists';
import {
  ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE,
  ASSISTANT_SETTINGS_VIEW,
} from '../contracts/permissions';
import { UNANSWERED_REASONS } from '../domain/insights';

// The saved filters of the admin assistant insights list, the unanswered questions (super list,
// CLAUDE.md rule 14), through the generic routes of `lists`. This module keeps the meaning of a
// saved filter's document and the keys that guard the list; `lists` keeps the table, the caps, the
// names and the sharing rules. The document is closed: the view, the reason and a minimum count
// (as the panel keeps them), the sort and its direction. The search text, which can hold buyer
// words, is never saved, and no query text is part of a document.

export const INSIGHTS_LIST_KEY = 'admin.assistant.insights';

/** The views of the list (tabs): all, and one per way a turn goes unanswered. */
export const INSIGHTS_VIEWS = ['all', 'thumbs-down', 'no-results', 'failed'] as const;
/** "At least N times asked" choices of the filter panel. */
export const INSIGHTS_MIN_COUNTS = ['2', '5', '10'] as const;
export const INSIGHTS_SORTS = ['count', 'last', 'query'] as const;

const FILTERS: readonly (readonly [string, ClosedFilterRule])[] = [
  ['reason', { kind: 'word', values: UNANSWERED_REASONS }],
  ['minCount', { kind: 'word', values: INSIGHTS_MIN_COUNTS }],
];

export const parseInsightsFilterPayload = closedListPayloadParser({
  views: INSIGHTS_VIEWS,
  defaultView: 'all',
  filters: FILTERS,
  sorts: INSIGHTS_SORTS,
});

/**
 * The list assistant registers for admins: the insights, guarded by the settings view key (the
 * key the insights route checks); sharing a filter needs the module's own protected share key.
 */
export const ASSISTANT_LISTS: readonly ListDefinition[] = [
  {
    listKey: INSIGHTS_LIST_KEY,
    population: 'admin',
    viewKey: ASSISTANT_SETTINGS_VIEW.key,
    shareKey: ASSISTANT_INSIGHTS_SAVED_FILTER_SHARE.key,
    parsePayload: parseInsightsFilterPayload,
  },
];
