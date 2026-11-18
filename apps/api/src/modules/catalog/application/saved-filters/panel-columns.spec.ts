import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_ORDER_COLUMNS,
  SELLER_ORDER_COLUMNS,
} from '../../../ordering/application/saved-views/list-definitions';
import { ADMIN_PRODUCT_COLUMNS, SELLER_PRODUCT_COLUMNS } from './list-definitions';

// The column ids of the admin Products and Orders lists live in the panel (`OPTIONAL_COLUMNS`) and
// in the API (the vocabulary a list registers with `lists`). The API drops an id it does not
// offer, so the two must not drift: this reads the panel's files and compares.

const ROOT = join(__dirname, '../../../../../../..');
const idsOf = (file: string): string[] => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const block = /export const OPTIONAL_COLUMNS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
};

describe('the panels and the API agree on the column ids', () => {
  it('Products', () => {
    expect(ADMIN_PRODUCT_COLUMNS).toEqual(idsOf('apps/admin/src/catalog/products-types.ts'));
  });
  it('Orders', () => {
    expect(ADMIN_ORDER_COLUMNS).toEqual(idsOf('apps/admin/src/orders/orders-columns.ts'));
  });
  it('seller Products', () => {
    expect(SELLER_PRODUCT_COLUMNS).toEqual(idsOf('apps/seller/src/catalog/products-list-types.ts'));
  });
  it('seller Orders', () => {
    expect(SELLER_ORDER_COLUMNS).toEqual(idsOf('apps/seller/src/orders/orders-columns.ts'));
  });
});
