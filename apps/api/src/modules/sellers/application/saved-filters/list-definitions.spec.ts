import { LISTS_AUDIT_LIST_KEYS } from '../../../lists/domain/audit';
import { SELLERS_PERMISSIONS, SELLERS_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { SELLER_HEALTH_METRICS } from '../../domain/seller-health';
import { SellerHealthQueueRead } from '../use-cases/seller-health-queue.use-case';
import { SellerList } from '../use-cases/list.use-case';
import { SELLERS_LISTS } from './list-definitions';

// The saved-filter documents of the admin Sellers list (15) and the "Needs a look" health queue
// (16): closed and versioned, `{ v: 1, view, filters?, sort?, direction? }`, holding only what the
// list route accepts.

const byKey = (key: string) => {
  const list = SELLERS_LISTS.find((candidate) => candidate.listKey === key);
  if (list === undefined) throw new Error(`missing ${key}`);
  return list;
};
const SELLER_LIST = byKey('admin.sellers.list');
const HEALTH_QUEUE = byKey('admin.sellers.health-queue');
const fieldsOf = (result: ReturnType<typeof SELLER_LIST.parsePayload>) =>
  result.ok ? null : result.error.fields;

describe('the sellers saved-filter lists', () => {
  it('registers the two admin lists, guarded by the key their list routes check', () => {
    expect(SELLERS_LISTS.map((list) => list.listKey)).toEqual([
      'admin.sellers.list',
      'admin.sellers.health-queue',
    ]);
    expect(SellerList.access.rule).toEqual({ kind: 'permissions', allOf: [SELLER_LIST.viewKey] });
    expect(SellerHealthQueueRead.access.rule).toEqual({
      kind: 'permissions',
      allOf: [HEALTH_QUEUE.viewKey],
    });
    for (const list of SELLERS_LISTS) {
      expect(list.population).toBe('admin');
      expect(list.shareKey).toBe(SELLERS_SAVED_FILTER_SHARE.key);
      expect(list.columns).toBeUndefined();
      expect(LISTS_AUDIT_LIST_KEYS).toContain(list.listKey);
    }
  });

  it('declares the share key with the module, unprotected', () => {
    expect(SELLERS_PERMISSIONS.declarations).toContainEqual(SELLERS_SAVED_FILTER_SHARE);
    expect(SELLERS_SAVED_FILTER_SHARE).toMatchObject({
      key: 'sellers.saved-filter.share',
      scope: 'platform',
      protected: false,
    });
  });

  describe('admin.sellers.health-queue', () => {
    it.each(['all', ...SELLER_HEALTH_METRICS])('keeps the view %s', (view) => {
      const payload = {
        v: 1,
        view,
        filters: { minScore: '0', maxScore: '100' },
        sort: 'day',
        direction: 'desc',
      };
      const result = HEALTH_QUEUE.parsePayload(payload);
      expect(result).toEqual({ ok: true, value: payload });
      if (result.ok) expect(HEALTH_QUEUE.parsePayload(result.value)).toEqual(result);
    });

    it('keeps one end of the range, and an equal range', () => {
      expect(HEALTH_QUEUE.parsePayload({ v: 1, view: 'all', filters: { maxScore: '40' } })).toEqual(
        { ok: true, value: { v: 1, view: 'all', filters: { maxScore: '40' } } },
      );
      expect(
        HEALTH_QUEUE.parsePayload({
          v: 1,
          view: 'all',
          filters: { minScore: '35', maxScore: '35' },
        }).ok,
      ).toBe(true);
    });

    it.each([
      [{ v: 1, view: 'healthy' }, 'payload.view', 'value'],
      [{ v: 1, view: 'all', sort: 'band' }, 'payload.sort', 'value'],
      [{ v: 1, view: 'all', q: 'falafel' }, 'payload.q', 'unknown'],
      [{ v: 1, view: 'all', filters: { q: 'falafel' } }, 'payload.filters.q', 'unknown'],
      [{ v: 1, view: 'all', filters: { metric: 'reports' } }, 'payload.filters.metric', 'unknown'],
      [{ v: 1, view: 'all', filters: { minScore: 10 } }, 'payload.filters.minScore', 'type'],
      [{ v: 1, view: 'all', filters: { minScore: '101' } }, 'payload.filters.minScore', 'format'],
      [{ v: 1, view: 'all', filters: { maxScore: '-1' } }, 'payload.filters.maxScore', 'format'],
      [{ v: 1, view: 'all', filters: { maxScore: '050' } }, 'payload.filters.maxScore', 'format'],
      [
        { v: 1, view: 'all', filters: { minScore: '60', maxScore: '20' } },
        'payload.filters.maxScore',
        'range',
      ],
    ])('refuses %j at %s (%s)', (raw, path, code) => {
      expect(fieldsOf(HEALTH_QUEUE.parsePayload(raw))).toEqual([{ path, code }]);
    });
  });

  describe('admin.sellers.list', () => {
    it.each([
      ['awaiting-review', { kind: 'identity-change', areaCode: 'greater-brisbane' }, 'name', 'asc'],
      ['incomplete', { outsideArea: true, areaCode: 'akl-1' }, 'queue', 'desc'],
      ['all', { areaCode: 'greater-brisbane' }, 'name', 'desc'],
      ['changes-needed', undefined, 'queue', 'desc'],
      ['not-approved', undefined, undefined, undefined],
      ['approved', undefined, 'queue', undefined],
      ['suspended', undefined, undefined, 'desc'],
    ] as const)('keeps a document of the tab %s', (view, filters, sort, direction) => {
      const payload = {
        v: 1,
        view,
        ...(filters === undefined ? {} : { filters }),
        ...(sort === undefined ? {} : { sort }),
        ...(direction === undefined ? {} : { direction }),
      };
      const result = SELLER_LIST.parsePayload(payload);
      expect(result).toEqual({ ok: true, value: payload });
      if (result.ok) expect(SELLER_LIST.parsePayload(result.value)).toEqual(result);
    });

    it('reads a document without a view as All, and outsideArea false as no filter', () => {
      expect(SELLER_LIST.parsePayload({ v: 1 })).toEqual({
        ok: true,
        value: { v: 1, view: 'all' },
      });
      expect(
        SELLER_LIST.parsePayload({ v: 1, view: 'incomplete', filters: { outsideArea: false } }),
      ).toEqual({ ok: true, value: { v: 1, view: 'incomplete' } });
    });

    it.each([
      [{ v: 1, view: 'rejected' }, 'payload.view', 'value'],
      [{ v: 1, view: 'all', sort: 'submitted' }, 'payload.sort', 'value'],
      [{ v: 1, view: 'all', q: 'falafel' }, 'payload.q', 'unknown'],
      [{ v: 1, view: 'all', filters: { search: 'x' } }, 'payload.filters.search', 'unknown'],
      [
        { v: 1, view: 'awaiting-review', filters: { kind: 'renewal' } },
        'payload.filters.kind',
        'value',
      ],
      [
        { v: 1, view: 'incomplete', filters: { outsideArea: 'true' } },
        'payload.filters.outsideArea',
        'type',
      ],
      [
        { v: 1, view: 'all', filters: { areaCode: 'Greater Brisbane' } },
        'payload.filters.areaCode',
        'format',
      ],
      [
        { v: 1, view: 'all', filters: { areaCode: 'a'.repeat(65) } },
        'payload.filters.areaCode',
        'format',
      ],
      [
        { v: 1, view: 'all', filters: { kind: 'onboarding' } },
        'payload.filters.kind',
        'outside-view',
      ],
      [
        { v: 1, view: 'all', filters: { outsideArea: true } },
        'payload.filters.outsideArea',
        'outside-view',
      ],
      [
        { v: 1, view: 'approved', filters: { areaCode: 'bne' } },
        'payload.filters.areaCode',
        'outside-view',
      ],
      [{ v: 1, view: 'suspended', sort: 'name' }, 'payload.sort', 'outside-view'],
      [{ v: 1, view: 'changes-needed', direction: 'asc' }, 'payload.direction', 'outside-view'],
    ])('refuses %j at %s (%s)', (raw, path, code) => {
      expect(fieldsOf(SELLER_LIST.parsePayload(raw))).toEqual([{ path, code }]);
    });
  });
});
