import type { ListDefinition } from '../../../lists';
import {
  ORDERING_ORDER_VIEW,
  ORDERING_SAVED_FILTER_SHARE,
  ORDERING_SELLER_ORDER_VIEW,
} from '../../contracts/permissions';
import { savedFilterListOf } from './saved-view-lists';

// The lists ordering registers with `lists` (super list B0-1b) so they have saved filters through
// the generic routes. The payload parser is the list's own; the keys are the ones that guard it.
// The seller order list is account-scoped and cannot be shared: it has no share key.

/** The columns an admin can show in the Orders list, after the order reference (always shown). */
export const ADMIN_ORDER_COLUMNS: readonly string[] = [
  'status',
  'placed',
  'paid',
  'customer',
  'sellers',
  'total',
];

const ORDERS = savedFilterListOf('admin.ordering.orders');
const SELLER_ORDERS = savedFilterListOf('seller.ordering.orders');

const fail = (): never => {
  throw new Error('ORDERING_LISTS: the list is missing from its saved-filter lists');
};

export const ORDERING_LISTS: readonly ListDefinition[] =
  ORDERS === null || SELLER_ORDERS === null
    ? fail()
    : [
        {
          listKey: ORDERS.key,
          population: 'admin',
          viewKey: ORDERING_ORDER_VIEW.key,
          shareKey: ORDERING_SAVED_FILTER_SHARE.key,
          columns: ADMIN_ORDER_COLUMNS,
          parsePayload: (raw) => ORDERS.parsePayload(raw),
        },
        {
          // Personal to the seller account across its stores; never shared.
          listKey: SELLER_ORDERS.key,
          population: 'seller',
          scope: 'account',
          viewKey: ORDERING_SELLER_ORDER_VIEW.key,
          parsePayload: (raw) => SELLER_ORDERS.parsePayload(raw),
        },
      ];
