import type { ListDefinition } from '../../../lists';
import {
  CATALOG_OWN_PRODUCT_VIEW,
  CATALOG_OWN_SAVED_FILTER_SHARE,
  CATALOG_PRODUCT_VIEW,
  CATALOG_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { SAVED_FILTER_LISTS } from './saved-filter-lists';
import { SELLER_SAVED_FILTER_LISTS } from './seller-saved-filter-lists';

// The lists catalog registers with `lists` (super list B0-1b) so they have saved filters through
// the generic routes. The payload parser is the list's own; the keys are the ones that guard it.

/**
 * The columns an admin can choose in the Products list, after the four always shown (image, title,
 * status, category). The panel's `OPTIONAL_COLUMNS` must keep the same ids.
 */
export const ADMIN_PRODUCT_COLUMNS: readonly string[] = [
  'code',
  'offers',
  'updated',
  'type',
  'scope',
  'seller',
  'created',
  'tags',
];

/** The columns a seller can choose in the Products list, after the always-shown ones. */
export const SELLER_PRODUCT_COLUMNS: readonly string[] = [
  'code',
  'updated',
  'created',
  'offers',
  'type',
];

const PRODUCTS = SAVED_FILTER_LISTS['admin.catalog.products'];
const OWN_PRODUCTS = SELLER_SAVED_FILTER_LISTS['seller.catalog.products'];

const fail = (): never => {
  throw new Error('CATALOG_LISTS: the list is missing from its saved-filter lists');
};

export const CATALOG_LISTS: readonly ListDefinition[] =
  PRODUCTS === undefined || OWN_PRODUCTS === undefined
    ? fail()
    : [
        {
          listKey: PRODUCTS.key,
          population: 'admin',
          viewKey: CATALOG_PRODUCT_VIEW.key,
          shareKey: CATALOG_SAVED_FILTER_SHARE.key,
          columns: ADMIN_PRODUCT_COLUMNS,
          parsePayload: (raw) => PRODUCTS.parsePayload(raw),
        },
        {
          // One set of filters per store; a member may share one with the store.
          listKey: OWN_PRODUCTS.key,
          population: 'seller',
          scope: 'store',
          viewKey: CATALOG_OWN_PRODUCT_VIEW.key,
          shareKey: CATALOG_OWN_SAVED_FILTER_SHARE.key,
          columns: SELLER_PRODUCT_COLUMNS,
          parsePayload: (raw) => OWN_PRODUCTS.parsePayload(raw),
        },
      ];
