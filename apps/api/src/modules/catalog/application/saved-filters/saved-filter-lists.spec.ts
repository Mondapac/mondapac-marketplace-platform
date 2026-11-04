import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import { SAVED_FILTER_AUDIT_LISTS } from '../../domain/audit';
import { SavedFilterCreate } from '../use-cases/saved-filter-create.use-case';
import { SavedFilterDelete } from '../use-cases/saved-filter-delete.use-case';
import { SavedFilterUpdate } from '../use-cases/saved-filter-update.use-case';
import { SavedFiltersList } from '../use-cases/saved-filters-list.use-case';
import {
  SAVED_FILTER_LISTS,
  SAVED_FILTER_LIST_KEYS,
  savedFilterListOf,
} from './saved-filter-lists';

// The registry of lists that keep saved filters. The use cases check one view key; this test fails
// when a list is added whose view key differs, until the use cases check it too.

describe('the lists that keep saved filters', () => {
  it('every list is shown by the key the saved-filter use cases check', () => {
    for (const list of Object.values(SAVED_FILTER_LISTS)) {
      expect(list.viewKey).toBe(CATALOG_PRODUCT_VIEW.key);
    }
    for (const useCase of [
      SavedFiltersList,
      SavedFilterCreate,
      SavedFilterUpdate,
      SavedFilterDelete,
    ]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [CATALOG_PRODUCT_VIEW.key],
      });
    }
  });

  it('every list key is a code the audit vocabulary and the table’s CHECK accept', () => {
    expect([...SAVED_FILTER_LIST_KEYS].sort()).toEqual([...SAVED_FILTER_AUDIT_LISTS].sort());
    for (const key of SAVED_FILTER_LIST_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/);
      expect(key.length).toBeLessThanOrEqual(64);
    }
  });

  it('finds a list by its exact key only, never by an inherited property', () => {
    expect(savedFilterListOf('admin.catalog.products')).not.toBeNull();
    for (const key of ['toString', '__proto__', 'constructor', 'ADMIN.CATALOG.PRODUCTS', 5, null]) {
      expect(savedFilterListOf(key)).toBeNull();
    }
  });
});

describe('the product list’s saved document', () => {
  const list = savedFilterListOf('admin.catalog.products')!;
  const valid = { v: 1, view: 'all', filters: {}, sort: 'created', direction: 'desc' };

  it('accepts the smallest document and the fullest one', () => {
    expect(list.parsePayload(valid)).toEqual({ ok: true, value: valid });
    const full = {
      v: 1,
      view: 'inactive',
      q: 'lamb',
      filters: {
        scope: 'PLATFORM',
        status: 'paused',
        categoryId: '0190a000-0000-7000-8000-000000000001',
        typeCode: 'simple',
        sellerId: '0190a000-0000-7000-8000-000000000002',
      },
      sort: 'name',
      direction: 'asc',
    };
    expect(list.parsePayload(full)).toEqual({ ok: true, value: full });
  });

  it('requires the tab, sort and direction', () => {
    for (const key of ['view', 'sort', 'direction']) {
      const rest: Record<string, unknown> = { ...valid };
      delete rest[key];
      expect(list.parsePayload(rest)).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [{ path: `payload.${key}`, code: 'required' }],
        },
      });
    }
  });

  it('refuses a key it does not know at the top and in the filters', () => {
    expect(list.parsePayload({ ...valid, page: 2 })).toMatchObject({ ok: false });
    expect(list.parsePayload({ ...valid, filters: { view: 'all' } })).toMatchObject({ ok: false });
  });

  it('builds the filter the list counts from a saved document', () => {
    const parsed = list.parsePayload({ ...valid, view: 'inactive', filters: { scope: 'SELLER' } });
    if (!parsed.ok) throw new Error('expected a valid document');
    const filter = list.countFilter(parsed.value, 'en-AU')!;
    expect(filter.scope).toBe('SELLER');
    expect(filter.locale).toBe('en-AU');
    expect(filter.matches).toEqual([
      { status: 'unpublished', paused: null },
      { status: 'withdrawn', paused: null },
      { status: 'published', paused: true },
    ]);
  });
});
