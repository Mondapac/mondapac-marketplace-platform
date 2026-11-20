import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import {
  ACCOUNT_DELETION_REQUESTS_VIEW,
  CUSTOMERS_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { DELETION_LIST_VIEWS, DELETION_SORT_KEYS } from '../../domain/admin-deletion-list';
import { parseDeletionSelector } from '../admin-deletion-list-flow';

// The list customers registers with `lists` (super list phase 4, PR10) so it has saved filters
// through the generic routes: the admin Account deletion requests list (25). The Customers list
// keeps its own saved filters (customers' routes) until it moves to `lists`. The selector keys of
// a saved filter go through the list's own reading, so a saved value is exactly one the list
// accepts; the keys are the ones that guard it. The older list's `status` is not a saved key.

const DELETION_REQUESTS: ListDefinition = {
  listKey: 'admin.customers.deletion-requests',
  population: 'admin',
  viewKey: ACCOUNT_DELETION_REQUESTS_VIEW.key,
  shareKey: CUSTOMERS_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: DELETION_LIST_VIEWS,
    filterKeys: ['requestedBy', 'cancelReason', 'from', 'to', 'scheduledBefore'],
    sorts: DELETION_SORT_KEYS,
    read(query) {
      const fields: ListQueryField[] = [];
      const filter = parseDeletionSelector(query, fields);
      return {
        fields,
        canonical: canonicalQuery({
          q: filter.requestOrAccountId,
          requestedBy: filter.requestedBy,
          cancelReason: filter.cancelReason,
          from: filter.from,
          to: filter.to,
          scheduledBefore: filter.scheduledBefore,
        }),
      };
    },
  }),
};

export const CUSTOMERS_LISTS: readonly ListDefinition[] = [DELETION_REQUESTS];
