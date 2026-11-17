import type { ListDefinition } from '../../../lists';
import { CATALOG_PRODUCT_VIEW, CATALOG_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { SAVED_FILTER_LISTS } from './saved-filter-lists';

// The lists catalog registers with `lists` (super list B0-1b) so they have saved filters through
// the generic routes. The payload parser is the list's own; the keys are the ones that guard it.

const PRODUCTS = SAVED_FILTER_LISTS['admin.catalog.products'];

const fail = (): never => {
  throw new Error('CATALOG_LISTS: the list is missing from its saved-filter lists');
};

export const CATALOG_LISTS: readonly ListDefinition[] =
  PRODUCTS === undefined
    ? fail()
    : [
        {
          listKey: PRODUCTS.key,
          population: 'admin',
          viewKey: CATALOG_PRODUCT_VIEW.key,
          shareKey: CATALOG_SAVED_FILTER_SHARE.key,
          parsePayload: (raw) => PRODUCTS.parsePayload(raw),
        },
      ];
