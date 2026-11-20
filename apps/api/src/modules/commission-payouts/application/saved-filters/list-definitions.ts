import {
  canonicalQuery,
  savedListPayloadParser,
  type ListDefinition,
  type ListQueryField,
} from '../../../lists';
import {
  COMMISSION_PAYOUTS_DISPUTE_VIEW,
  COMMISSION_PAYOUTS_PAYOUT_VIEW,
  COMMISSION_PAYOUTS_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { DISPUTE_LIST_VIEWS, DISPUTE_SORT_KEYS } from '../../domain/admin-dispute-list';
import { PAYOUT_LIST_VIEWS, PAYOUT_SORT_KEYS } from '../../domain/admin-payout-list';
import { parseDisputeSelector } from '../admin-dispute-list-flow';
import { parsePayoutSelector } from '../admin-payout-list-flow';

// The lists commission-payouts registers with `lists` (super list phase 4, PR10) so they have
// saved filters through the generic routes: the admin Payouts list (21) and the admin Disputes
// list (23). The selector keys of a saved filter go through the list's own reading, so a saved
// value is exactly one the list accepts; the keys are the ones that guard each list.

const PAYOUTS: ListDefinition = {
  listKey: 'admin.commission-payouts.payouts',
  population: 'admin',
  viewKey: COMMISSION_PAYOUTS_PAYOUT_VIEW.key,
  shareKey: COMMISSION_PAYOUTS_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: PAYOUT_LIST_VIEWS,
    filterKeys: [
      'status',
      'search',
      'sellerId',
      'approvalMode',
      'from',
      'to',
      'minAmount',
      'maxAmount',
    ],
    sorts: PAYOUT_SORT_KEYS,
    read(query) {
      const fields: ListQueryField[] = [];
      const { filter, search } = parsePayoutSelector(query, fields);
      return {
        fields,
        canonical: canonicalQuery({
          q: filter.payoutId,
          status: filter.state,
          search,
          sellerId: filter.sellerId,
          approvalMode: filter.approvalMode,
          from: filter.from,
          to: filter.to,
          minAmount: filter.minAmount,
          maxAmount: filter.maxAmount,
        }),
      };
    },
  }),
};

const DISPUTES: ListDefinition = {
  listKey: 'admin.commission-payouts.disputes',
  population: 'admin',
  viewKey: COMMISSION_PAYOUTS_DISPUTE_VIEW.key,
  shareKey: COMMISSION_PAYOUTS_SAVED_FILTER_SHARE.key,
  parsePayload: savedListPayloadParser({
    views: DISPUTE_LIST_VIEWS,
    filterKeys: [
      'status',
      'money',
      'search',
      'sellerId',
      'from',
      'to',
      'dueBefore',
      'minAmount',
      'maxAmount',
    ],
    sorts: DISPUTE_SORT_KEYS,
    read(query) {
      const fields: ListQueryField[] = [];
      const { filter, sellerId, search } = parseDisputeSelector(query, fields);
      return {
        fields,
        canonical: canonicalQuery({
          q: filter.caseOrOrderId,
          status: filter.status,
          money: filter.moneyState,
          search,
          sellerId,
          from: filter.from,
          to: filter.to,
          dueBefore: filter.dueBefore,
          minAmount: filter.minAmount,
          maxAmount: filter.maxAmount,
        }),
      };
    },
  }),
};

export const COMMISSION_PAYOUTS_LISTS: readonly ListDefinition[] = [PAYOUTS, DISPUTES];
