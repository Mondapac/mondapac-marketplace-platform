import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import {
  PRICING_PRICE_HOLD_SAVED_FILTER_SHARE,
  PRICING_PRICE_HOLD_VIEW,
} from '../../contracts/permissions';
import { HOLD_LIST_VIEWS, HOLD_SORT_KEYS } from '../../domain/hold-list';
import { parseHoldSelector } from '../admin-hold-list-flow';

// The list pricing registers with `lists` (super list phase 3, list 19; CLAUDE.md rule 14) so the
// admin price-hold list has saved filters through the generic routes. The document is the closed,
// versioned shape of `savedListPayloadParser`: the view, `q` (a record or Offer id), the filter keys
// of the list's query, the sort and its direction; paging and columns are never saved. Its selector
// keys go through the list's own reading, so a saved value is exactly one the list accepts, kept in
// canonical form. `kind` and `change` are kept only when given: the view already names its own.

export const HOLD_LIST_KEY = 'admin.pricing.price-holds';

const FILTER_KEYS = ['kind', 'change', 'sellerId', 'from', 'to', 'minAmount', 'maxAmount'] as const;

const PRICE_HOLDS: ListDefinition = {
  listKey: HOLD_LIST_KEY,
  population: 'admin',
  viewKey: PRICING_PRICE_HOLD_VIEW.key,
  shareKey: PRICING_PRICE_HOLD_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: HOLD_LIST_VIEWS,
    filterKeys: FILTER_KEYS,
    sorts: HOLD_SORT_KEYS,
    read(query) {
      const selector = parseHoldSelector(query);
      if (!selector.ok) {
        const fields: readonly ListQueryField[] = selector.error.fields;
        return { fields, canonical: {} };
      }
      const { filter } = selector.value;
      return {
        fields: [],
        canonical: canonicalQuery({
          q: filter.recordOrOfferId,
          kind: query['kind'] === undefined ? null : filter.kind,
          change: query['change'] === undefined ? null : filter.direction,
          sellerId: filter.sellerId,
          from: filter.from,
          to: filter.to,
          minAmount: filter.minAmount,
          maxAmount: filter.maxAmount,
        }),
      };
    },
  }),
};

export const PRICING_LISTS: readonly ListDefinition[] = [PRICE_HOLDS];
