import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { cursorText, listStatusOf, parseListRequest, type ListStatusInput } from './seller-list';

// The admin seller list (sellers design 7.8; slice 6): the request's shape, the keyset cursor
// and the status a row shows. Pure rules; nothing here names a Market.

const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;
const REVISION = '01928a3c-0000-7000-8000-0000000000a1' as Id<'BusinessFileRevision'>;
const WHEN = Temporal.Instant.from('2026-10-09T01:02:03.456Z');

const problems = (raw: unknown) => {
  const parsed = parseListRequest(raw);
  return parsed.ok ? null : parsed.error.fields;
};

describe('parseListRequest', () => {
  it('defaults to the first page of the awaiting-review tab', () => {
    expect(parseListRequest({})).toEqual({
      ok: true,
      value: {
        tab: 'awaiting-review',
        kind: null,
        outsideArea: false,
        search: null,
        after: null,
        limit: 25,
      },
    });
  });

  it('accepts a missing body as the empty request', () => {
    expect(parseListRequest(undefined).ok).toBe(true);
  });

  it('reads each tab with its own filter', () => {
    const awaiting = parseListRequest({ tab: 'awaiting-review', kind: 'identity-change' });
    const incomplete = parseListRequest({ tab: 'incomplete', outsideArea: true, limit: 50 });

    expect(awaiting.ok && awaiting.value.kind).toBe('identity-change');
    expect(incomplete.ok && incomplete.value).toMatchObject({ outsideArea: true, limit: 50 });
  });

  it('refuses a filter that does not belong to the tab', () => {
    expect(problems({ tab: 'all', kind: 'onboarding' })).toEqual([{ path: 'kind', code: 'tab' }]);
    expect(problems({ tab: 'all', outsideArea: true })).toEqual([
      { path: 'outsideArea', code: 'tab' },
    ]);
    expect(problems({ tab: 'awaiting-review', outsideArea: true })).toEqual([
      { path: 'outsideArea', code: 'tab' },
    ]);
  });

  it('is closed: unknown fields are named, sorted, and never echo a value', () => {
    expect(problems({ tab: 'all', sellerId: 'x', marketId: 'ZZ' })).toEqual([
      { path: 'marketId', code: 'unknown-field' },
      { path: 'sellerId', code: 'unknown-field' },
    ]);
  });

  it('checks the types and bounds without echoing them', () => {
    expect(problems('all')).toEqual([{ path: '', code: 'type' }]);
    expect(problems([])).toEqual([{ path: '', code: 'type' }]);
    expect(problems({ tab: 'tabs' })).toEqual([{ path: 'tab', code: 'value' }]);
    expect(problems({ tab: 3 })).toEqual([{ path: 'tab', code: 'type' }]);
    expect(problems({ limit: 0 })).toEqual([{ path: 'limit', code: 'range' }]);
    expect(problems({ limit: 51 })).toEqual([{ path: 'limit', code: 'range' }]);
    expect(problems({ limit: 2.5 })).toEqual([{ path: 'limit', code: 'range' }]);
    expect(problems({ limit: '25' })).toEqual([{ path: 'limit', code: 'type' }]);
    expect(problems({ outsideArea: 'yes', tab: 'incomplete' })).toEqual([
      { path: 'outsideArea', code: 'type' },
    ]);
  });

  describe('search', () => {
    it('folds the term like the store-name key and keeps it a prefix of 2 to 100 characters', () => {
      const parsed = parseListRequest({ search: '  Al   HALAL  ' });

      expect(parsed.ok && parsed.value.search).toEqual({ nameKey: 'al halal', slug: null });
    });

    it('also searches the slug when the term has only slug characters', () => {
      const parsed = parseListRequest({ search: 'Al-Halal2' });

      expect(parsed.ok && parsed.value.search).toEqual({ nameKey: 'al-halal2', slug: 'al-halal2' });
    });

    it('treats a blank term as no search', () => {
      const parsed = parseListRequest({ search: '   ' });

      expect(parsed.ok && parsed.value.search).toBeNull();
    });

    it('refuses a term that is too short or too long, and control characters', () => {
      expect(problems({ search: 'a' })).toEqual([{ path: 'search', code: 'length' }]);
      expect(problems({ search: 'x'.repeat(101) })).toEqual([{ path: 'search', code: 'length' }]);
      expect(problems({ search: 'ab\u0000cd' })).toEqual([{ path: 'search', code: 'characters' }]);
    });
  });

  describe('the cursor', () => {
    it('round-trips for each tab, bound to the tab', () => {
      for (const cursor of [
        { tab: 'all', sellerId: SELLER },
        { tab: 'incomplete', changedAt: WHEN, sellerId: SELLER },
        { tab: 'awaiting-review', createdAt: WHEN, revisionId: REVISION },
      ] as const) {
        const parsed = parseListRequest({ tab: cursor.tab, after: cursorText(cursor) });

        expect(parsed.ok && parsed.value.after).toEqual(cursor);
      }
    });

    it('refuses a cursor of another tab, and a malformed one, as format', () => {
      const other = cursorText({ tab: 'all', sellerId: SELLER });

      expect(problems({ tab: 'incomplete', after: other })).toEqual([
        { path: 'after', code: 'format' },
      ]);
      for (const bad of ['', 'x', 'all.nope', 'incomplete.12.nope', `incomplete.-1.${SELLER}`]) {
        expect(problems({ tab: 'incomplete', after: bad })).toEqual([
          { path: 'after', code: 'format' },
        ]);
      }
      expect(problems({ after: 5 })).toEqual([{ path: 'after', code: 'type' }]);
    });
  });
});

describe('listStatusOf', () => {
  const base: ListStatusInput = {
    access: 'pending',
    hasApprovedRevision: false,
    pendingKind: null,
    draftComplete: true,
    outsideServiceArea: false,
  };

  it.each([
    ['details-incomplete', { draftComplete: false }],
    ['ready-to-submit', {}],
    ['outside-service-area', { outsideServiceArea: true }],
    ['awaiting-review', { pendingKind: 'onboarding' }],
    ['changes-needed', { access: 'rejected' }],
    ['approved', { access: 'approved', hasApprovedRevision: true }],
    ['file-check-needed', { access: 'approved' }],
    ['suspended', { access: 'suspended', hasApprovedRevision: true }],
  ] as const)('is %s for %j', (code, patch) => {
    expect(listStatusOf({ ...base, ...(patch as Partial<ListStatusInput>) })).toBe(code);
  });

  it('does not take a pending change request for a pending application', () => {
    expect(
      listStatusOf({
        ...base,
        access: 'approved',
        hasApprovedRevision: true,
        pendingKind: 'identity-change',
      }),
    ).toBe('approved');
  });

  it('has no status for a seller identity does not know: never a guess', () => {
    expect(listStatusOf({ ...base, access: null })).toBeNull();
  });
});
