import { COMMISSION_PAYOUTS_LISTS } from './list-definitions';
import {
  COMMISSION_PAYOUTS_DISPUTE_VIEW,
  COMMISSION_PAYOUTS_EARNINGS_VIEW,
  COMMISSION_PAYOUTS_OWN_SAVED_FILTER_SHARE,
  COMMISSION_PAYOUTS_PAYOUT_VIEW,
  COMMISSION_PAYOUTS_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { ExportOwnPayouts } from '../use-cases/export-own-payouts.use-case';
import { ListDisputes } from '../use-cases/list-disputes.use-case';
import { ListPayouts } from '../use-cases/list-payouts.use-case';

// The saved-filter documents of the admin Payouts and Disputes lists (super list phase 4, PR10):
// closed and versioned, read by each list's own selector, stored in canonical form.

const ID = '01990000-0000-7000-8000-00000000A001';
const listOf = (key: string) => {
  const list = COMMISSION_PAYOUTS_LISTS.find((candidate) => candidate.listKey === key);
  if (list === undefined) throw new Error(`missing ${key}`);
  return list;
};
const PAYOUTS = listOf('admin.commission-payouts.payouts');
const DISPUTES = listOf('admin.commission-payouts.disputes');
const OWN_PAYOUTS = listOf('seller.commission-payouts.payouts');
const fieldsOf = (result: ReturnType<typeof PAYOUTS.parsePayload>) =>
  result.ok ? null : result.error.fields;

describe('the commission-payouts saved-filter lists', () => {
  it('guards each list with the key its list use case checks, and shares with the module key', () => {
    expect(PAYOUTS.viewKey).toBe(COMMISSION_PAYOUTS_PAYOUT_VIEW.key);
    expect(ListPayouts.access.rule).toEqual({ kind: 'permissions', allOf: [PAYOUTS.viewKey] });
    expect(DISPUTES.viewKey).toBe(COMMISSION_PAYOUTS_DISPUTE_VIEW.key);
    expect(ListDisputes.access.rule).toEqual({ kind: 'permissions', allOf: [DISPUTES.viewKey] });
    for (const list of [PAYOUTS, DISPUTES]) {
      expect(list.population).toBe('admin');
      expect(list.shareKey).toBe(COMMISSION_PAYOUTS_SAVED_FILTER_SHARE.key);
    }
  });

  it('keeps a payouts document in its canonical form', () => {
    const result = PAYOUTS.parsePayload({
      v: 1,
      view: 'sending',
      q: ` ${ID} `,
      filters: {
        status: 'INSTRUCTED',
        search: '  Halal Corner ',
        sellerId: ID,
        approvalMode: 'MANUAL',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-10T00:00:00+10:00',
        minAmount: '0100',
        maxAmount: '',
      },
      sort: 'amount',
      direction: 'asc',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'sending',
        q: ID.toLowerCase(),
        filters: {
          status: 'instructed',
          search: 'Halal Corner',
          sellerId: ID.toLowerCase(),
          approvalMode: 'MANUAL',
          from: '2026-11-01T00:00:00Z',
          to: '2026-11-09T14:00:00Z',
          minAmount: '100',
        },
        sort: 'amount',
        direction: 'asc',
      },
    });
    // The canonical form reads back to itself.
    if (result.ok) expect(PAYOUTS.parsePayload(result.value)).toEqual(result);
  });

  it('keeps a disputes document in its canonical form, without empty parts', () => {
    expect(
      DISPUTES.parsePayload({
        v: 1,
        view: 'all',
        filters: { money: 'withdrawn', dueBefore: '2026-11-20T00:00:00Z' },
        sort: 'evidence-due',
        direction: 'desc',
      }),
    ).toEqual({
      ok: true,
      value: {
        v: 1,
        view: 'all',
        filters: { money: 'withdrawn', dueBefore: '2026-11-20T00:00:00Z' },
        sort: 'evidence-due',
        direction: 'desc',
      },
    });
  });

  it.each([
    [{ v: 1, view: 'all', sort: 'created', direction: 'desc', page: 2 }, 'payload.page', 'unknown'],
    [
      { v: 1, view: 'all', filters: { cursor: 'x' }, sort: 'created', direction: 'desc' },
      'payload.filters.cursor',
      'unknown',
    ],
    [{ v: 2, view: 'all', sort: 'created', direction: 'desc' }, 'payload.v', 'value'],
    [{ v: 1, sort: 'created', direction: 'desc' }, 'payload.view', 'required'],
    [{ v: 1, view: 'held', sort: 'created', direction: 'desc' }, 'payload.view', 'value'],
    [{ v: 1, view: 'all', sort: 'opened', direction: 'desc' }, 'payload.sort', 'value'],
    [{ v: 1, view: 'all', sort: 'created', direction: 'up' }, 'payload.direction', 'value'],
    [
      { v: 1, view: 'all', filters: { approvalMode: 'auto' }, sort: 'created', direction: 'desc' },
      'payload.filters.approvalMode',
      'value',
    ],
    [
      { v: 1, view: 'all', filters: { minAmount: '1.5' }, sort: 'created', direction: 'desc' },
      'payload.filters.minAmount',
      'format',
    ],
    [
      { v: 1, view: 'all', filters: { search: 'x' }, sort: 'created', direction: 'desc' },
      'payload.filters.search',
      'length',
    ],
    [
      {
        v: 1,
        view: 'all',
        filters: { from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' },
        sort: 'created',
        direction: 'desc',
      },
      'payload.filters.to',
      'range',
    ],
    [
      { v: 1, view: 'all', q: 'not-an-id', sort: 'created', direction: 'desc' },
      'payload.q',
      'format',
    ],
    [
      { v: 1, view: 'all', filters: { sellerId: 7 }, sort: 'created', direction: 'desc' },
      'payload.filters.sellerId',
      'type',
    ],
  ])('refuses a payouts document that is not one the list accepts (%#)', (payload, path, code) => {
    expect(fieldsOf(PAYOUTS.parsePayload(payload))).toContainEqual({ path, code });
  });

  it('refuses a disputes document with the older `filter` key or a payouts sort', () => {
    const base = { v: 1, view: 'all', sort: 'opened', direction: 'desc' };
    expect(fieldsOf(DISPUTES.parsePayload({ ...base, filters: { filter: 'open' } }))).toEqual([
      { path: 'payload.filters.filter', code: 'unknown' },
    ]);
    expect(fieldsOf(DISPUTES.parsePayload({ ...base, sort: 'slot' }))).toEqual([
      { path: 'payload.sort', code: 'value' },
    ]);
    expect(fieldsOf(DISPUTES.parsePayload('{}'))).toEqual([{ path: 'payload', code: 'type' }]);
  });

  describe('the seller Earnings › Payouts list (33)', () => {
    it('is a store list guarded by the earnings key and shared with the own share key', () => {
      expect(OWN_PAYOUTS.population).toBe('seller');
      expect(OWN_PAYOUTS.scope).toBe('store');
      expect(OWN_PAYOUTS.viewKey).toBe(COMMISSION_PAYOUTS_EARNINGS_VIEW.key);
      // The same key as the list's export.
      expect(ExportOwnPayouts.access.rule).toEqual({
        kind: 'permissions',
        allOf: [OWN_PAYOUTS.viewKey],
      });
      expect(OWN_PAYOUTS.shareKey).toBe(COMMISSION_PAYOUTS_OWN_SAVED_FILTER_SHARE.key);
    });

    it('keeps a document in its canonical form', () => {
      expect(
        OWN_PAYOUTS.parsePayload({
          v: 1,
          q: ` ${ID} `,
          filters: {
            status: 'paid',
            from: '2026-11-01T00:00:00+10:00',
            to: '',
            minAmount: '0100',
            maxAmount: '2500',
          },
          sort: 'amount',
          direction: 'asc',
        }),
      ).toEqual({
        ok: true,
        value: {
          v: 1,
          q: ID.toLowerCase(),
          filters: {
            status: 'paid',
            from: '2026-10-31T14:00:00Z',
            minAmount: '100',
            maxAmount: '2500',
          },
          sort: 'amount',
          direction: 'asc',
        },
      });
    });

    it.each([
      [
        { v: 1, view: 'all', filters: {}, sort: 'created', direction: 'desc' },
        'payload.view',
        'unknown',
      ],
      [
        { v: 1, filters: { sellerId: ID }, sort: 'created', direction: 'desc' },
        'payload.filters.sellerId',
        'unknown',
      ],
      [
        { v: 1, filters: { status: 'VOIDED' }, sort: 'created', direction: 'desc' },
        'payload.filters.status',
        'value',
      ],
      [
        { v: 1, filters: { minAmount: '9', maxAmount: '1' }, sort: 'created', direction: 'desc' },
        'payload.filters.maxAmount',
        'range',
      ],
      [{ v: 1, filters: {}, sort: 'seller', direction: 'desc' }, 'payload.sort', 'value'],
    ])('refuses a document the list does not accept (%#)', (payload, path, code) => {
      expect(fieldsOf(OWN_PAYOUTS.parsePayload(payload))).toContainEqual({ path, code });
    });
  });
});
