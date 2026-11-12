import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { parseListQuery } from '../use-cases/own-products-list.use-case';
import { OwnSavedFilterCreate } from '../use-cases/own-saved-filter-create.use-case';
import { OwnSavedFilterDelete } from '../use-cases/own-saved-filter-delete.use-case';
import { OwnSavedFilterUpdate } from '../use-cases/own-saved-filter-update.use-case';
import { OwnSavedFiltersList } from '../use-cases/own-saved-filters-list.use-case';
import { SAVED_FILTER_LIST_KEYS } from './saved-filter-lists';
import {
  SELLER_SAVED_FILTER_LISTS,
  SELLER_SAVED_FILTER_LIST_KEYS,
  sellerSavedFilterListOf,
} from './seller-saved-filter-lists';

// The registry of seller lists that keep saved filters, and the saved document of the seller
// Products list: it is the list's own selector, read by the list's own closed parser.

const CATEGORY = '0190a000-0000-7000-8000-000000000001';

describe('the seller lists that keep saved filters', () => {
  it('every list is shown by the key the seller saved-filter use cases check', () => {
    for (const list of Object.values(SELLER_SAVED_FILTER_LISTS)) {
      expect(list.viewKey).toBe(CATALOG_OWN_PRODUCT_VIEW.key);
    }
    for (const useCase of [
      OwnSavedFiltersList,
      OwnSavedFilterCreate,
      OwnSavedFilterUpdate,
      OwnSavedFilterDelete,
    ]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CATALOG_OWN_PRODUCT_VIEW.key],
      });
    }
  });

  it('every seller list key starts with `seller.` (the table’s CHECK) and no admin key does', () => {
    for (const key of SELLER_SAVED_FILTER_LIST_KEYS) expect(key.startsWith('seller.')).toBe(true);
    for (const key of SAVED_FILTER_LIST_KEYS) expect(key.startsWith('seller.')).toBe(false);
  });

  it('finds a list by its exact key only, never an admin list or an inherited property', () => {
    expect(sellerSavedFilterListOf('seller.catalog.products')).not.toBeNull();
    for (const key of [
      'admin.catalog.products',
      'seller-products',
      'toString',
      '__proto__',
      'SELLER.CATALOG.PRODUCTS',
      5,
      null,
    ]) {
      expect(sellerSavedFilterListOf(key)).toBeNull();
    }
  });
});

describe('the seller product list’s saved document', () => {
  const list = sellerSavedFilterListOf('seller.catalog.products')!;

  it('resolves the tab, sort and direction like the list does', () => {
    expect(list.parsePayload({ v: 1 })).toEqual({
      ok: true,
      value: { v: 1, view: 'all', sort: 'updated', direction: 'desc' },
    });
    expect(list.parsePayload({ v: 1, sort: 'name' })).toEqual({
      ok: true,
      value: { v: 1, view: 'all', sort: 'name', direction: 'asc' },
    });
  });

  it('accepts the fullest document and keeps a false `paused`', () => {
    const full = {
      v: 1,
      view: 'live',
      q: 'dates',
      status: 'published',
      categoryId: CATEGORY,
      paused: false,
      typeCode: 'simple',
      sort: 'created',
      direction: 'asc',
    };
    expect(list.parsePayload(full)).toEqual({ ok: true, value: full });
  });

  it('stores the search as the list reads it and drops empty values', () => {
    expect(list.parsePayload({ v: 1, q: '  dates ', status: '', typeCode: null })).toEqual({
      ok: true,
      value: { v: 1, view: 'all', q: 'dates', sort: 'updated', direction: 'desc' },
    });
    expect(list.parsePayload({ v: 1, q: '   ' })).toMatchObject({
      ok: true,
      value: { view: 'all' },
    });
  });

  it('is exactly a document the list would accept as a query', () => {
    const parsed = list.parsePayload({ v: 1, view: 'inactive', paused: true, sort: 'name' });
    if (!parsed.ok) throw new Error('expected a valid document');
    const { v, ...query } = parsed.value;
    expect(v).toBe(1);
    expect(parseListQuery(query)).toMatchObject({
      ok: true,
      value: { view: 'inactive', paused: true, sort: 'name', direction: 'asc' },
    });
  });

  it('requires version 1 and an object', () => {
    for (const raw of [undefined, null, [], 'x', 5]) {
      expect(list.parsePayload(raw)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'payload', code: 'type' }] },
      });
    }
    for (const v of [undefined, 0, 2, '1']) {
      expect(list.parsePayload({ v })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'payload.v', code: 'value' }] },
      });
    }
  });

  it.each([
    [{ page: 2 }, 'payload.page', 'unknown'],
    [{ pageSize: 25 }, 'payload.pageSize', 'unknown'],
    [{ afterId: CATEGORY }, 'payload.afterId', 'unknown'],
    [{ filters: {} }, 'payload.filters', 'unknown'],
    [{ view: 'archived' }, 'payload.view', 'value'],
    [{ status: 'withdrawn' }, 'payload.status', 'value'],
    [{ status: 'discarded' }, 'payload.status', 'value'],
    [{ categoryId: 'not-an-id' }, 'payload.categoryId', 'format'],
    [{ paused: 'yes' }, 'payload.paused', 'value'],
    [{ typeCode: 'Not A Code' }, 'payload.typeCode', 'format'],
    [{ q: 'x'.repeat(101) }, 'payload.q', 'length'],
    [{ q: 'bad\u0007' }, 'payload.q', 'format'],
    [{ sort: 'price' }, 'payload.sort', 'value'],
    [{ direction: 'up' }, 'payload.direction', 'value'],
  ])('refuses %j at %s (%s)', (extra, path, code) => {
    expect(list.parsePayload({ v: 1, ...extra })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code }] },
    });
  });
});
