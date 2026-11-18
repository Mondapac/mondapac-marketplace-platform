import { rowActions } from '../../../../platform/list-query';
import { OWN_OFFER_ACTION_RULES, parseOfferListQuery } from './own-offers-list.use-case';

const EDIT = new Set(['catalog.own-product.edit']);
const row = (status: string, productScope: string | null = 'PLATFORM') =>
  ({ status, productScope }) as never;

describe('own Offer list row actions', () => {
  it('offers edit, submit and delete on a draft', () => {
    expect(rowActions(row('draft'), OWN_OFFER_ACTION_RULES, EDIT)).toEqual([
      'open',
      'edit',
      'submit',
      'delete',
    ]);
  });

  it('offers delete on a live or waiting Offer too, as own-offer.delete allows it', () => {
    expect(rowActions(row('published'), OWN_OFFER_ACTION_RULES, EDIT)).toEqual([
      'open',
      'edit',
      'delete',
    ]);
  });

  it('hides delete on an Offer of the seller own product and when the scope is unknown', () => {
    expect(rowActions(row('draft', 'SELLER'), OWN_OFFER_ACTION_RULES, EDIT)).toEqual([
      'open',
      'edit',
      'submit',
    ]);
    expect(rowActions(row('draft', null), OWN_OFFER_ACTION_RULES, EDIT)).toEqual([
      'open',
      'edit',
      'submit',
    ]);
  });

  it('offers edit and delete when changes are needed, but not submit', () => {
    expect(rowActions(row('changes-needed'), OWN_OFFER_ACTION_RULES, EDIT)).toEqual([
      'open',
      'edit',
      'delete',
    ]);
  });

  it('offers open, edit and delete, never submit, while the Offer waits for review', () => {
    expect(rowActions(row('pending-first-publish'), OWN_OFFER_ACTION_RULES, EDIT)).toEqual([
      'open',
      'edit',
      'delete',
    ]);
  });

  it('offers only open without the edit key', () => {
    expect(rowActions(row('draft'), OWN_OFFER_ACTION_RULES, new Set())).toEqual(['open']);
  });
});

describe('own Offer list query', () => {
  const fields = (path: string, code: string) => ({
    ok: false,
    error: { code: 'validation.failed', fields: [{ path, code }] },
  });

  it('takes the defaults: pages, newest first, 25 rows', () => {
    expect(parseOfferListQuery({ page: 1 })).toEqual({
      ok: true,
      value: {
        view: 'all',
        text: null,
        status: null,
        listed: null,
        sort: 'created',
        direction: 'desc',
        page: 1,
        pageSize: 25,
        paging: 'pages',
      },
    });
  });

  it('sorts a SKU from A to Z by default and trims the search text', () => {
    const parsed = parseOfferListQuery({ sort: 'sku', q: '  olive  ', paging: 'prev-next' });
    expect(parsed).toMatchObject({
      ok: true,
      value: { direction: 'asc', text: 'olive', paging: 'prev-next' },
    });
  });

  it('refuses what does not fit, field by field', () => {
    expect(parseOfferListQuery({ view: 'bogus' })).toEqual(fields('view', 'value'));
    expect(parseOfferListQuery({ status: 'deleted' })).toEqual(fields('status', 'value'));
    expect(parseOfferListQuery({ sort: 'name' })).toEqual(fields('sort', 'value'));
    expect(parseOfferListQuery({ pageSize: 30 })).toEqual(fields('pageSize', 'range'));
    expect(parseOfferListQuery({ page: 0 })).toEqual(fields('page', 'range'));
    expect(parseOfferListQuery({ q: 'a'.repeat(101) })).toEqual(fields('q', 'length'));
    expect(parseOfferListQuery({ q: 'a\u0000b' })).toEqual(fields('q', 'format'));
    expect(parseOfferListQuery({ limit: 5 })).toEqual(fields('limit', 'unknown'));
  });

  it('stops page numbers at row 10,000 in both paging modes', () => {
    for (const paging of ['pages', 'prev-next']) {
      expect(parseOfferListQuery({ page: 400, pageSize: 25, paging })).toMatchObject({ ok: true });
      expect(parseOfferListQuery({ page: 401, pageSize: 25, paging })).toEqual(
        fields('page', 'range'),
      );
      expect(parseOfferListQuery({ page: 101, pageSize: 100, paging })).toEqual(
        fields('page', 'range'),
      );
    }
  });

  it('treats a blank search as no search', () => {
    expect(parseOfferListQuery({ q: '   ', page: 1 })).toMatchObject({
      ok: true,
      value: { text: null },
    });
  });
});
