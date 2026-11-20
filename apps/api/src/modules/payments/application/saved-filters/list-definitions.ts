import { Temporal } from '@mondapac/shared-kernel';
import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import {
  PAYMENTS_CONNECTED_ACCOUNT_VIEW,
  PAYMENTS_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { ACCOUNT_SORT_KEYS } from '../../domain/connected-account-list';
import { selectorOf } from '../admin-account-list-flow';

// The list payments registers with `lists` (super list phase 4, PR10) so it has saved filters
// through the generic routes: the admin Seller accounts list (22, the connected accounts). It has
// no views: the status is a filter. The selector keys of a saved filter go through the list's own
// reading, so a saved value is exactly one the list accepts; the keys are the ones that guard it.

/**
 * The reader judges `ready` and `waiting` at an instant it puts in the filter; a saved filter keeps
 * only the words, so any instant does here (the list reads the clock when it runs).
 */
const UNUSED_NOW = Temporal.Instant.fromEpochMilliseconds(0);

const CONNECTED_ACCOUNTS: ListDefinition = {
  listKey: 'admin.payments.connected-accounts',
  population: 'admin',
  viewKey: PAYMENTS_CONNECTED_ACCOUNT_VIEW.key,
  shareKey: PAYMENTS_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: null,
    filterKeys: ['status', 'ready', 'requirements', 'waiting', 'from', 'to'],
    sorts: ACCOUNT_SORT_KEYS,
    read(query) {
      const fields: ListQueryField[] = [];
      const { filter, search } = selectorOf(fields, query, UNUSED_NOW);
      return {
        fields,
        canonical: canonicalQuery({
          // A seller id finds that seller; any other text is a store-name search.
          q: filter.sellerId ?? search,
          status: filter.status,
          ready: filter.ready === null ? null : filter.ready ? 'yes' : 'no',
          requirements: filter.requirements,
          waiting: filter.waiting,
          from: filter.from,
          to: filter.to,
        }),
      };
    },
  }),
};

export const PAYMENTS_LISTS: readonly ListDefinition[] = [CONNECTED_ACCOUNTS];
