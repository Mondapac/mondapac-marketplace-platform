import type { ListDefinition } from '../../../lists';
import { ORDERING_ORDER_VIEW, ORDERING_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { savedFilterListOf } from './saved-view-lists';

// The lists ordering registers with `lists` (super list B0-1b) so they have saved filters through
// the generic routes. The payload parser is the list's own; the keys are the ones that guard it.
// The admin Sales lists (Shipments, Refunds and Invoices) are guarded like the Orders list.
// The seller order list is account-scoped and cannot be shared; it joins with the seller routes.

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
    parsePayload: (raw) => list.parsePayload(raw),
  };
};

export const ORDERING_LISTS: readonly ListDefinition[] = ADMIN_LIST_KEYS.map(definitionOf);
