import type { Id } from '@mondapac/shared-kernel';
import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import { WALLET_CREDIT_VIEW, WALLET_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { CREDIT_LIST_VIEWS, CREDIT_SORT_KEYS } from '../../domain/admin-credit-list';
import { parseCreditSelector } from '../admin-credit-list-flow';

// The list wallet registers with `lists` (super list phase 4, PR10) so it has saved filters
// through the generic routes: the admin Credit requests list (24). The selector keys of a saved
// filter go through the list's own reading, so a saved value is exactly one the list accepts; the
// keys are the ones that guard it. A saved document always names its view, so the older queue's
// `status`-as-view reading never applies to it.

/**
 * The reader turns `requestedBy=me` into the caller's account; a saved filter keeps the word `me`
 * (it means whoever opens the filter), so the account given to the reader is never stored.
 */
const NOBODY = '00000000-0000-0000-0000-000000000000' as Id<'Account'>;

const CREDIT_REQUESTS: ListDefinition = {
  listKey: 'admin.wallet.credit-requests',
  population: 'admin',
  viewKey: WALLET_CREDIT_VIEW.key,
  shareKey: WALLET_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: CREDIT_LIST_VIEWS,
    filterKeys: [
      'status',
      'reason',
      'approvalReason',
      'requestedBy',
      'from',
      'to',
      'minAmount',
      'maxAmount',
    ],
    sorts: CREDIT_SORT_KEYS,
    read(query) {
      const fields: ListQueryField[] = [];
      const filter = parseCreditSelector(query, NOBODY, fields);
      return {
        fields,
        canonical: canonicalQuery({
          q: filter.requestOrCustomerId,
          status: filter.status,
          reason: filter.reason,
          approvalReason: filter.approvalReason,
          requestedBy: query['requestedBy'] === 'me' ? 'me' : filter.requestedBy,
          from: filter.from,
          to: filter.to,
          minAmount: filter.minAmount,
          maxAmount: filter.maxAmount,
        }),
      };
    },
  }),
};

export const WALLET_LISTS: readonly ListDefinition[] = [CREDIT_REQUESTS];
