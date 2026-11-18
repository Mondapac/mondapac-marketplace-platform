import { LISTS_AUDIT_LIST_KEYS } from '../../../lists/domain/audit';
import {
  CERTIFICATION_PERMISSIONS,
  CERTIFICATION_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { IssuerRequestsQueue } from '../use-cases/issuer-requests-queue.use-case';
import { SellerCertificatesQueue } from '../use-cases/seller-certificates-queue.use-case';
import { CERTIFICATION_LISTS } from './list-definitions';

// The saved-filter documents of the admin Issuer requests list and the certificate review queue:
// closed and versioned, in the shape the panels save (`{ v: 1, view, filters?, sort?, direction? }`).

const byKey = (key: string) => {
  const list = CERTIFICATION_LISTS.find((candidate) => candidate.listKey === key);
  if (list === undefined) throw new Error(`missing ${key}`);
  return list;
};
const ISSUER_REQUESTS = byKey('admin.certification.issuer-requests');
const REVIEW_QUEUE = byKey('admin.certification.review-queue');
const fieldsOf = (result: ReturnType<typeof ISSUER_REQUESTS.parsePayload>) =>
  result.ok ? null : result.error.fields;

describe('the certification saved-filter lists', () => {
  it('registers the two admin lists, each guarded by the key its queue checks', () => {
    expect(CERTIFICATION_LISTS.map((list) => list.listKey)).toEqual([
      'admin.certification.issuer-requests',
      'admin.certification.review-queue',
    ]);
    expect(IssuerRequestsQueue.access.rule).toEqual({
      kind: 'permissions',
      allOf: [ISSUER_REQUESTS.viewKey],
    });
    expect(SellerCertificatesQueue.access.rule).toEqual({
      kind: 'permissions',
      allOf: [REVIEW_QUEUE.viewKey],
    });
    for (const list of CERTIFICATION_LISTS) {
      expect(list.population).toBe('admin');
      expect(list.shareKey).toBe(CERTIFICATION_SAVED_FILTER_SHARE.key);
      expect(list.columns).toBeUndefined();
      expect(LISTS_AUDIT_LIST_KEYS).toContain(list.listKey);
    }
  });

  it('declares the share key with the module, unprotected', () => {
    expect(CERTIFICATION_PERMISSIONS.declarations).toContainEqual(CERTIFICATION_SAVED_FILTER_SHARE);
    expect(CERTIFICATION_SAVED_FILTER_SHARE).toMatchObject({
      key: 'certification.saved-filter.share',
      scope: 'platform',
      protected: false,
    });
  });

  describe('admin.certification.issuer-requests', () => {
    it('keeps what the panel saves, canonical and stable', () => {
      const payload = {
        v: 1,
        view: 'all',
        filters: { type: 'halal', submitted: 'last-30-days' },
        sort: 'type',
        direction: 'desc',
      };
      const result = ISSUER_REQUESTS.parsePayload(payload);
      expect(result).toEqual({ ok: true, value: payload });
      if (result.ok) expect(ISSUER_REQUESTS.parsePayload(result.value)).toEqual(result);
      expect(ISSUER_REQUESTS.parsePayload({ v: 1, view: 'all' })).toEqual({
        ok: true,
        value: { v: 1, view: 'all' },
      });
    });

    it.each([
      [{ v: 1, view: 'initial' }, 'payload.view', 'value'],
      [{ v: 1, view: 'all', sort: 'queue' }, 'payload.sort', 'value'],
      [{ v: 1, view: 'all', q: 'some id' }, 'payload.q', 'unknown'],
      [{ v: 1, view: 'all', filters: { sellerId: 'x' } }, 'payload.filters.sellerId', 'unknown'],
      [{ v: 1, view: 'all', filters: { from: '2026-11-01' } }, 'payload.filters.from', 'unknown'],
      [{ v: 1, view: 'all', filters: { type: 'Halal' } }, 'payload.filters.type', 'format'],
      [{ v: 1, view: 'all', filters: { type: 'a'.repeat(65) } }, 'payload.filters.type', 'format'],
      [
        { v: 1, view: 'all', filters: { submitted: 'last-year' } },
        'payload.filters.submitted',
        'value',
      ],
      [{ v: 1, view: 'all', direction: 'sideways' }, 'payload.direction', 'value'],
      [{ v: 2, view: 'all' }, 'payload.v', 'value'],
    ])('refuses %j at %s (%s)', (raw, path, code) => {
      expect(fieldsOf(ISSUER_REQUESTS.parsePayload(raw))).toEqual([{ path, code }]);
    });

    it('takes a type code at its longest', () => {
      const type = `a${'b'.repeat(63)}`;
      expect(ISSUER_REQUESTS.parsePayload({ v: 1, view: 'all', filters: { type } }).ok).toBe(true);
    });
  });

  describe('admin.certification.review-queue', () => {
    it.each(['all', 'initial', 'resubmission', 'renewal'])('keeps the view %s', (view) => {
      const payload = {
        v: 1,
        view,
        filters: { type: 'kosher', submitted: 'today' },
        sort: 'queue',
        direction: 'asc',
      };
      expect(REVIEW_QUEUE.parsePayload(payload)).toEqual({ ok: true, value: payload });
    });

    it('takes every sort the queue offers', () => {
      for (const sort of ['queue', 'submitted', 'type']) {
        expect(REVIEW_QUEUE.parsePayload({ v: 1, view: 'all', sort }).ok).toBe(true);
      }
    });

    it.each([
      [{ v: 1, view: 'expired' }, 'payload.view', 'value'],
      [{ v: 1, view: 'all', sort: 'seller' }, 'payload.sort', 'value'],
      [{ v: 1, view: 'all', page: 1 }, 'payload.page', 'unknown'],
      [{ v: 1, view: 'all', filters: { kind: 'renewal' } }, 'payload.filters.kind', 'unknown'],
      [{ v: 1, view: 'all', filters: { type: 'x y' } }, 'payload.filters.type', 'format'],
      [{ v: 1, view: 'all', filters: { submitted: 7 } }, 'payload.filters.submitted', 'type'],
    ])('refuses %j at %s (%s)', (raw, path, code) => {
      expect(fieldsOf(REVIEW_QUEUE.parsePayload(raw))).toEqual([{ path, code }]);
    });
  });
});
