import {
  PRICING_PRICE_HOLD_SAVED_FILTER_SHARE,
  PRICING_PRICE_HOLD_VIEW,
} from '../../contracts/permissions';
import { ListPriceHolds } from '../use-cases/list-price-holds.use-case';
import { HOLD_LIST_KEY, PRICING_LISTS } from './list-definitions';

// The saved-filter document of the admin price-hold list (super list phase 3, list 19): closed and
// versioned, read by the list's own selector, stored in canonical form. The view key is the one the
// list use case checks; sharing needs pricing's own protected key.

const RECORD = '01990000-0000-7000-8000-00000000AB01';
const SELLER = '01990000-0000-7000-8000-00000000ab02';
const [LIST] = PRICING_LISTS;
if (LIST === undefined) throw new Error('missing list');
const fieldsOf = (result: ReturnType<typeof LIST.parsePayload>) =>
  result.ok ? null : result.error.fields;
const BASE = { v: 1, view: 'all', sort: 'submitted', direction: 'asc' } as const;

describe('the pricing saved-filter list', () => {
  it('is guarded by the key the list use case checks and shared with a protected pricing key', () => {
    expect(PRICING_LISTS).toHaveLength(1);
    expect(LIST.listKey).toBe(HOLD_LIST_KEY);
    expect(LIST.listKey).toBe('admin.pricing.price-holds');
    expect(LIST.population).toBe('admin');
    expect(LIST.viewKey).toBe(PRICING_PRICE_HOLD_VIEW.key);
    expect(ListPriceHolds.access.rule).toEqual({ kind: 'permissions', allOf: [LIST.viewKey] });
    expect(LIST.shareKey).toBe(PRICING_PRICE_HOLD_SAVED_FILTER_SHARE.key);
    expect(PRICING_PRICE_HOLD_SAVED_FILTER_SHARE).toMatchObject({
      key: 'pricing.price-hold-saved-filter.share',
      scope: 'platform',
      protected: true,
    });
    expect(LIST.columns).toBeUndefined();
  });

  it('keeps the smallest document as it is', () => {
    expect(LIST.parsePayload(BASE)).toEqual({ ok: true, value: { ...BASE, filters: {} } });
  });

  it('keeps a document in its canonical form', () => {
    const result = LIST.parsePayload({
      ...BASE,
      view: 'special',
      q: ` ${RECORD} `,
      sort: 'amount',
      direction: 'desc',
      filters: {
        change: 'up',
        sellerId: SELLER,
        from: '2026-11-01T00:00:00+10:00',
        to: '2026-11-08T00:00:00Z',
        minAmount: '0500',
        maxAmount: '900',
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'special',
        q: RECORD.toLowerCase(),
        sort: 'amount',
        direction: 'desc',
        filters: {
          change: 'up',
          sellerId: SELLER,
          from: '2026-10-31T14:00:00Z',
          to: '2026-11-08T00:00:00Z',
          minAmount: '500',
          maxAmount: '900',
        },
      },
    });
    if (result.ok) expect(LIST.parsePayload(result.value)).toEqual(result);
  });

  it('keeps `kind` and `change` only when the document gives them, not the ones its view implies', () => {
    expect(LIST.parsePayload({ ...BASE, view: 'regular' })).toEqual({
      ok: true,
      value: { ...BASE, view: 'regular', filters: {} },
    });
    expect(LIST.parsePayload({ ...BASE, view: 'up', filters: { kind: 'special' } })).toEqual({
      ok: true,
      value: { ...BASE, view: 'up', filters: { kind: 'special' } },
    });
  });

  it('drops blank values', () => {
    expect(LIST.parsePayload({ ...BASE, q: '  ', filters: { sellerId: '', kind: ' ' } })).toEqual({
      ok: true,
      value: { ...BASE, filters: {} },
    });
  });

  it.each([
    ['not a record', 'x', 'payload', 'type'],
    ['a paging key', { ...BASE, page: 2 }, 'payload.page', 'unknown'],
    [
      'a page size in filters',
      { ...BASE, filters: { pageSize: '50' } },
      'payload.filters.pageSize',
      'unknown',
    ],
    [
      'the view in filters',
      { ...BASE, filters: { view: 'all' } },
      'payload.filters.view',
      'unknown',
    ],
    ['columns', { ...BASE, columns: 'anchor' }, 'payload.columns', 'unknown'],
    ['another version', { ...BASE, v: 2 }, 'payload.v', 'value'],
    ['no view', { v: 1, sort: 'submitted', direction: 'asc' }, 'payload.view', 'required'],
    ['an unknown view', { ...BASE, view: 'held' }, 'payload.view', 'value'],
    ['an unknown sort', { ...BASE, sort: 'store' }, 'payload.sort', 'value'],
    ['no direction', { v: 1, view: 'all', sort: 'submitted' }, 'payload.direction', 'required'],
    ['a bad direction', { ...BASE, direction: 'up' }, 'payload.direction', 'value'],
    ['a name as q', { ...BASE, q: 'Halal lamb' }, 'payload.q', 'format'],
    ['a control character', { ...BASE, q: 'a\u0000' }, 'payload.q', 'format'],
    [
      'a number as a filter',
      { ...BASE, filters: { minAmount: 5 } },
      'payload.filters.minAmount',
      'type',
    ],
    ['an unknown kind', { ...BASE, filters: { kind: 'cost' } }, 'payload.filters.kind', 'value'],
    [
      'an unknown change',
      { ...BASE, filters: { change: 'flat' } },
      'payload.filters.change',
      'value',
    ],
    [
      'a bad seller id',
      { ...BASE, filters: { sellerId: 'x' } },
      'payload.filters.sellerId',
      'format',
    ],
    [
      'a bad instant',
      { ...BASE, filters: { from: 'yesterday' } },
      'payload.filters.from',
      'format',
    ],
    [
      'a range that ends before it starts',
      { ...BASE, filters: { from: '2026-11-08T00:00:00Z', to: '2026-11-01T00:00:00Z' } },
      'payload.filters.to',
      'range',
    ],
    [
      'a negative amount',
      { ...BASE, filters: { minAmount: '-1' } },
      'payload.filters.minAmount',
      'format',
    ],
    [
      'a decimal amount',
      { ...BASE, filters: { maxAmount: '1.50' } },
      'payload.filters.maxAmount',
      'format',
    ],
    [
      'a minimum above the maximum',
      { ...BASE, filters: { minAmount: '9', maxAmount: '1' } },
      'payload.filters.maxAmount',
      'range',
    ],
  ])('refuses %s, naming the field', (_name, payload, path, code) => {
    expect(fieldsOf(LIST.parsePayload(payload))).toContainEqual({ path, code });
  });
});
