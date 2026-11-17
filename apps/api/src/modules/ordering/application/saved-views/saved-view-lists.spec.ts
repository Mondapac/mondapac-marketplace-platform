import { LISTS_AUDIT_LIST_KEYS } from '../../../lists/domain/audit';
import { ORDERING_ORDER_VIEW, ORDERING_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { SAVED_FILTER_AUDIT_LISTS } from '../../domain/audit';
import { SAVED_FILTER_LIST_KEYS } from '../../domain/saved-view';
import { ORDERING_LISTS } from './list-definitions';
import { savedFilterListOf } from './saved-view-lists';

// The payload parsers of the admin Sales lists (Shipments, Refunds, Invoices) that keep saved
// filters through the generic lists routes. A payload is pure vocabulary (no Market, no money, no
// date): the date filters are relative presets stored as words, so the same document means the same
// thing in any Market and time zone. Search text is never part of a payload.

const SALES_LISTS = [
  'admin.ordering.shipments',
  'admin.ordering.refunds',
  'admin.ordering.documents',
] as const;

const DATE_PRESETS = [
  'today',
  'yesterday',
  'last-7-days',
  'last-30-days',
  'this-month',
  'last-month',
];

const parserOf = (key: string) => {
  const list = savedFilterListOf(key);
  if (list === null) throw new Error(`no list ${key}`);
  return (raw: unknown) => list.parsePayload(raw);
};

const refused = (path: string, code: string) => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

describe('the admin Sales lists that keep saved filters', () => {
  it('are order lists, admin lists, shareable, and in every vocabulary that names a list', () => {
    for (const key of SALES_LISTS) {
      const list = savedFilterListOf(key);
      expect(list).not.toBeNull();
      expect(list!.population).toBe('admin');
      expect(list!.shareable).toBe(true);
      expect(SAVED_FILTER_LIST_KEYS).toContain(key);
      expect(SAVED_FILTER_AUDIT_LISTS).toContain(key);
      expect(LISTS_AUDIT_LIST_KEYS).toContain(key);
    }
  });

  it('are registered with lists under the order view key and the saved-filter share key', () => {
    for (const key of ['admin.ordering.orders', ...SALES_LISTS]) {
      const definition = ORDERING_LISTS.find((list) => list.listKey === key);
      expect(definition).toBeDefined();
      expect(definition!.population).toBe('admin');
      expect(definition!.viewKey).toBe(ORDERING_ORDER_VIEW.key);
      expect(definition!.shareKey).toBe(ORDERING_SAVED_FILTER_SHARE.key);
    }
    expect(ORDERING_LISTS.map((list) => list.listKey)).toEqual([
      'admin.ordering.orders',
      ...SALES_LISTS,
    ]);
  });

  it('every admin order list in the audit vocabulary is one the code knows', () => {
    const admin = SAVED_FILTER_LIST_KEYS.filter((key) => key.startsWith('admin.'));
    expect([...SAVED_FILTER_AUDIT_LISTS].sort()).toEqual([...admin].sort());
  });

  describe.each(SALES_LISTS)('the payload of %s', (key) => {
    const parse = parserOf(key);

    it('must be an object with v 1, and refuses an unknown top-level key or search text', () => {
      for (const raw of [null, undefined, 'x', 1, [], [{ v: 1 }]]) {
        expect(parse(raw)).toEqual(refused('payload', 'type'));
      }
      expect(parse({})).toEqual(refused('payload.v', 'value'));
      expect(parse({ v: 2 })).toEqual(refused('payload.v', 'value'));
      expect(parse({ v: '1' })).toEqual(refused('payload.v', 'value'));
      expect(parse({ v: 1, q: 'lamb' })).toEqual(refused('payload.q', 'unknown'));
      expect(parse({ v: 1, columns: [] })).toEqual(refused('payload.columns', 'unknown'));
    });

    it('refuses a tab, filter, sort or direction outside the vocabulary, and a filters array', () => {
      expect(parse({ v: 1, tab: 'nope' })).toEqual(refused('payload.tab', 'value'));
      expect(parse({ v: 1, tab: 3 })).toEqual(refused('payload.tab', 'type'));
      expect(parse({ v: 1, filters: [] })).toEqual(refused('payload.filters', 'type'));
      expect(parse({ v: 1, filters: 'x' })).toEqual(refused('payload.filters', 'type'));
      expect(parse({ v: 1, filters: { nope: 'x' } })).toEqual(
        refused('payload.filters.nope', 'unknown'),
      );
      expect(parse({ v: 1, sort: 'nope' })).toEqual(refused('payload.sort', 'value'));
      expect(parse({ v: 1, sort: 1 })).toEqual(refused('payload.sort', 'type'));
      expect(parse({ v: 1, direction: 'up' })).toEqual(refused('payload.direction', 'value'));
      expect(parse({ v: 1, direction: true })).toEqual(refused('payload.direction', 'type'));
    });

    it('drops an empty filters object and leaves out sort and direction that were not given', () => {
      const bare = parse({ v: 1 });
      expect(bare.ok).toBe(true);
      const tab = bare.ok ? (bare.value as { tab: string }).tab : null;
      for (const raw of [
        { v: 1 },
        { v: 1, filters: {} },
        { v: 1, filters: null },
        { v: 1, sort: null, direction: null },
      ]) {
        expect(parse(raw)).toEqual({ ok: true, value: { v: 1, tab } });
      }
    });
  });

  describe('admin.ordering.shipments', () => {
    const parse = parserOf('admin.ordering.shipments');

    it('reads the canonical document and returns it unchanged', () => {
      const full = {
        v: 1,
        tab: 'attention',
        filters: {
          deliveryMethod: 'same_day',
          attention: 'carrier-unknown',
          paid: 'last-7-days',
          shipped: 'this-month',
        },
        sort: 'shipped',
        direction: 'asc',
      };
      expect(parse(full)).toEqual({ ok: true, value: full });
    });

    it('defaults the tab to all and accepts every tab, method, attention, preset and sort', () => {
      expect(parse({ v: 1 })).toEqual({ ok: true, value: { v: 1, tab: 'all' } });
      for (const tab of [
        'all',
        'attention',
        'to-prepare',
        'ready',
        'shipped',
        'delivered',
        'refunded',
      ]) {
        expect(parse({ v: 1, tab })).toEqual({ ok: true, value: { v: 1, tab } });
      }
      for (const deliveryMethod of ['pickup', 'instant', 'same_day', 'scheduled']) {
        expect(parse({ v: 1, filters: { deliveryMethod } }).ok).toBe(true);
      }
      for (const attention of ['any', 'no-carrier', 'carrier-unknown', 'cancel-unknown']) {
        expect(parse({ v: 1, filters: { attention } }).ok).toBe(true);
      }
      for (const preset of DATE_PRESETS) {
        expect(parse({ v: 1, filters: { paid: preset, shipped: preset } }).ok).toBe(true);
      }
      for (const sort of ['paid', 'shipped', 'delivered', 'total']) {
        for (const direction of ['asc', 'desc']) {
          expect(parse({ v: 1, sort, direction })).toEqual({
            ok: true,
            value: { v: 1, tab: 'all', sort, direction },
          });
        }
      }
    });

    it('drops empty filter entries and writes the filters in their canonical order', () => {
      const parsed = parse({
        v: 1,
        filters: { shipped: 'today', paid: '', attention: null, deliveryMethod: 'pickup' },
      });
      expect(parsed).toEqual({
        ok: true,
        value: { v: 1, tab: 'all', filters: { deliveryMethod: 'pickup', shipped: 'today' } },
      });
      expect(JSON.stringify(parsed.ok ? parsed.value : null)).toBe(
        '{"v":1,"tab":"all","filters":{"deliveryMethod":"pickup","shipped":"today"}}',
      );
      expect(parse({ v: 1, filters: { paid: '', shipped: null } })).toEqual({
        ok: true,
        value: { v: 1, tab: 'all' },
      });
    });

    it('refuses a value outside each filter vocabulary, a stored date and a wrong type', () => {
      expect(parse({ v: 1, filters: { deliveryMethod: 'same-day' } })).toEqual(
        refused('payload.filters.deliveryMethod', 'value'),
      );
      expect(parse({ v: 1, filters: { attention: 'all' } })).toEqual(
        refused('payload.filters.attention', 'value'),
      );
      expect(parse({ v: 1, filters: { paid: '2026-11-01' } })).toEqual(
        refused('payload.filters.paid', 'value'),
      );
      expect(parse({ v: 1, filters: { shipped: 7 } })).toEqual(
        refused('payload.filters.shipped', 'type'),
      );
      expect(parse({ v: 1, filters: { reason: 'damaged' } })).toEqual(
        refused('payload.filters.reason', 'unknown'),
      );
      expect(parse({ v: 1, tab: 'pending' })).toEqual(refused('payload.tab', 'value'));
      expect(parse({ v: 1, sort: 'amount' })).toEqual(refused('payload.sort', 'value'));
    });
  });

  describe('admin.ordering.refunds', () => {
    const parse = parserOf('admin.ordering.refunds');

    it('reads the canonical document and returns it unchanged', () => {
      const full = {
        v: 1,
        tab: 'failed',
        filters: {
          reason: 'not-as-described',
          actor: 'seller',
          lossBearer: 'platform',
          ledger: 'waiting',
          requested: 'last-30-days',
        },
        sort: 'amount',
        direction: 'desc',
      };
      expect(parse(full)).toEqual({ ok: true, value: full });
    });

    it('defaults the tab to all and accepts every tab, filter value, preset and sort', () => {
      expect(parse({ v: 1 })).toEqual({ ok: true, value: { v: 1, tab: 'all' } });
      for (const tab of ['all', 'pending', 'succeeded', 'failed']) {
        expect(parse({ v: 1, tab })).toEqual({ ok: true, value: { v: 1, tab } });
      }
      for (const reason of [
        'not-received',
        'damaged',
        'wrong-item',
        'not-as-described',
        'seller-cancelled',
        'item-unavailable',
        'other',
      ]) {
        expect(parse({ v: 1, filters: { reason } }).ok).toBe(true);
      }
      for (const actor of ['admin', 'seller']) {
        expect(parse({ v: 1, filters: { actor } }).ok).toBe(true);
      }
      for (const lossBearer of ['seller', 'platform']) {
        expect(parse({ v: 1, filters: { lossBearer } }).ok).toBe(true);
      }
      for (const ledger of ['waiting', 'recorded']) {
        expect(parse({ v: 1, filters: { ledger } }).ok).toBe(true);
      }
      for (const requested of DATE_PRESETS) {
        expect(parse({ v: 1, filters: { requested } }).ok).toBe(true);
      }
      for (const sort of ['requested', 'settled', 'amount']) {
        expect(parse({ v: 1, sort })).toEqual({ ok: true, value: { v: 1, tab: 'all', sort } });
      }
      expect(parse({ v: 1, direction: 'asc' })).toEqual({
        ok: true,
        value: { v: 1, tab: 'all', direction: 'asc' },
      });
    });

    it('drops empty filter entries and writes the filters in their canonical order', () => {
      const parsed = parse({
        v: 1,
        tab: 'pending',
        filters: { requested: 'yesterday', ledger: '', lossBearer: null, reason: 'other' },
      });
      expect(JSON.stringify(parsed.ok ? parsed.value : null)).toBe(
        '{"v":1,"tab":"pending","filters":{"reason":"other","requested":"yesterday"}}',
      );
    });

    it('refuses a value outside each filter vocabulary, a stored date and a wrong type', () => {
      expect(parse({ v: 1, filters: { reason: 'broken' } })).toEqual(
        refused('payload.filters.reason', 'value'),
      );
      expect(parse({ v: 1, filters: { actor: 'customer' } })).toEqual(
        refused('payload.filters.actor', 'value'),
      );
      expect(parse({ v: 1, filters: { lossBearer: 'customer' } })).toEqual(
        refused('payload.filters.lossBearer', 'value'),
      );
      expect(parse({ v: 1, filters: { ledger: 'done' } })).toEqual(
        refused('payload.filters.ledger', 'value'),
      );
      expect(parse({ v: 1, filters: { requested: '2026-11-01' } })).toEqual(
        refused('payload.filters.requested', 'value'),
      );
      expect(parse({ v: 1, filters: { actor: ['admin'] } })).toEqual(
        refused('payload.filters.actor', 'type'),
      );
      expect(parse({ v: 1, filters: { paid: 'today' } })).toEqual(
        refused('payload.filters.paid', 'unknown'),
      );
      expect(parse({ v: 1, tab: 'attention' })).toEqual(refused('payload.tab', 'value'));
      expect(parse({ v: 1, sort: 'total' })).toEqual(refused('payload.sort', 'value'));
    });
  });

  describe('admin.ordering.documents (the Invoices page)', () => {
    const parse = parserOf('admin.ordering.documents');

    it('reads the canonical document and returns it unchanged', () => {
      const full = {
        v: 1,
        tab: 'credit-note',
        filters: { issued: 'last-month' },
        sort: 'issued',
        direction: 'asc',
      };
      expect(parse(full)).toEqual({ ok: true, value: full });
    });

    it('defaults the tab to order-confirmation and accepts every tab, preset and sort', () => {
      expect(parse({ v: 1 })).toEqual({ ok: true, value: { v: 1, tab: 'order-confirmation' } });
      for (const tab of ['order-confirmation', 'credit-note']) {
        expect(parse({ v: 1, tab })).toEqual({ ok: true, value: { v: 1, tab } });
      }
      for (const issued of DATE_PRESETS) {
        expect(parse({ v: 1, filters: { issued } })).toEqual({
          ok: true,
          value: { v: 1, tab: 'order-confirmation', filters: { issued } },
        });
      }
      for (const sort of ['issued', 'amount']) {
        expect(parse({ v: 1, sort, direction: 'desc' })).toEqual({
          ok: true,
          value: { v: 1, tab: 'order-confirmation', sort, direction: 'desc' },
        });
      }
    });

    it('drops an empty issued filter', () => {
      for (const issued of ['', null, undefined]) {
        expect(parse({ v: 1, filters: { issued } })).toEqual({
          ok: true,
          value: { v: 1, tab: 'order-confirmation' },
        });
      }
    });

    it('refuses a value outside the vocabulary, a stored date and a wrong type', () => {
      expect(parse({ v: 1, tab: 'all' })).toEqual(refused('payload.tab', 'value'));
      expect(parse({ v: 1, filters: { issued: '2026-11-01' } })).toEqual(
        refused('payload.filters.issued', 'value'),
      );
      expect(parse({ v: 1, filters: { issued: 1 } })).toEqual(
        refused('payload.filters.issued', 'type'),
      );
      expect(parse({ v: 1, filters: { type: 'credit-note' } })).toEqual(
        refused('payload.filters.type', 'unknown'),
      );
      expect(parse({ v: 1, sort: 'requested' })).toEqual(refused('payload.sort', 'value'));
    });
  });

  describe('admin.ordering.orders (unchanged)', () => {
    const parse = parserOf('admin.ordering.orders');

    it('keeps its own vocabulary: no direction, dates as days and newest left out', () => {
      expect(
        parse({
          v: 1,
          tab: 'confirmed',
          filters: { paymentState: 'captured', from: '2026-11-01', to: '2026-11-02' },
          sort: 'newest',
        }),
      ).toEqual({
        ok: true,
        value: {
          v: 1,
          tab: 'confirmed',
          filters: { paymentState: 'captured', from: '2026-11-01', to: '2026-11-02' },
        },
      });
      expect(parse({ v: 1, direction: 'asc' })).toEqual(refused('payload.direction', 'unknown'));
    });
  });
});
