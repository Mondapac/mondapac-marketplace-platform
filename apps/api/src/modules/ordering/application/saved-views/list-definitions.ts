import type { ListDefinition } from '../../../lists';
import {
  ORDERING_ORDER_VIEW,
  ORDERING_SAVED_FILTER_SHARE,
  ORDERING_SELLER_ORDER_VIEW,
} from '../../contracts/permissions';
import { savedFilterListOf } from './saved-view-lists';

// The lists ordering registers with `lists` (super list B0-1b) so they have saved filters through
// the generic routes. The payload parser is the list's own; the keys are the ones that guard it.
// The admin Sales lists (Shipments, Refunds and Invoices) are guarded like the Orders list.
// The seller order list is account-scoped and cannot be shared: it has no share key.

/** The columns an admin can show in the Orders list, after the order reference (always shown). */
export const ADMIN_ORDER_COLUMNS: readonly string[] = [
  'placed',
  'paid',
  'payment',
  'customer',
  'sellers',
  'total',
];

/** The columns a seller can show in the Orders list, after the always-shown ones. */
export const SELLER_ORDER_COLUMNS: readonly string[] = ['paid', 'delivery', 'items', 'total'];

const ADMIN_LIST_KEYS = [
  'admin.ordering.orders',
  'admin.ordering.shipments',
  'admin.ordering.refunds',
  'admin.ordering.documents',
] as const;

const definitionOf = (key: (typeof ADMIN_LIST_KEYS)[number]): ListDefinition => {
  const list = savedFilterListOf(key);
  if (list === null) {
    throw new Error(`ORDERING_LISTS: ${key} is missing from its saved-filter lists`);
  }
  return {
    listKey: list.key,
    population: 'admin',
    viewKey: ORDERING_ORDER_VIEW.key,
    shareKey: ORDERING_SAVED_FILTER_SHARE.key,
    // Only the Orders list offers a stored column choice so far; the Sales lists keep theirs in
    // the panel until they move to column preferences.
    ...(key === 'admin.ordering.orders' ? { columns: ADMIN_ORDER_COLUMNS } : {}),
    parsePayload: (raw) => list.parsePayload(raw),
  };
};

const SELLER_ORDERS = savedFilterListOf('seller.ordering.orders');

const sellerOrders = (): ListDefinition => {
  if (SELLER_ORDERS === null) {
    throw new Error(
      'ORDERING_LISTS: seller.ordering.orders is missing from its saved-filter lists',
    );
  }
  return {
    // Personal to the seller account across its stores; never shared.
    listKey: SELLER_ORDERS.key,
    population: 'seller',
    scope: 'account',
    viewKey: ORDERING_SELLER_ORDER_VIEW.key,
    columns: SELLER_ORDER_COLUMNS,
    parsePayload: (raw) => SELLER_ORDERS.parsePayload(raw),
  };
};

export const ORDERING_LISTS: readonly ListDefinition[] = [
  ...ADMIN_LIST_KEYS.map(definitionOf),
  sellerOrders(),
];
