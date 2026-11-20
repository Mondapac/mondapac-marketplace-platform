import { CUSTOMERS_LISTS } from './list-definitions';
import {
  ACCOUNT_DELETION_REQUESTS_VIEW,
  CUSTOMERS_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { AdminListAccountDeletions } from '../use-cases/admin-list-account-deletions.use-case';

// The saved-filter document of the admin Account deletion requests list (super list phase 4,
// PR10): closed and versioned, read by the list's own selector, stored in canonical form.

const ID = '01990000-0000-7000-8000-00000000D001';
const [LIST] = CUSTOMERS_LISTS;
if (LIST === undefined) throw new Error('missing list');
const fieldsOf = (result: ReturnType<typeof LIST.parsePayload>) =>
  result.ok ? null : result.error.fields;
const BASE = { v: 1, view: 'pending', sort: 'scheduled', direction: 'asc' } as const;

describe('the customers saved-filter list', () => {
  it('is guarded by the key the list use case checks and shared with the module key', () => {
    expect(LIST.listKey).toBe('admin.customers.deletion-requests');
    expect(LIST.population).toBe('admin');
    expect(LIST.viewKey).toBe(ACCOUNT_DELETION_REQUESTS_VIEW.key);
    expect(AdminListAccountDeletions.access.rule).toEqual({
      kind: 'permissions',
      allOf: [LIST.viewKey],
    });
    expect(LIST.shareKey).toBe(CUSTOMERS_SAVED_FILTER_SHARE.key);
  });

  it('keeps a document in its canonical form', () => {
    const result = LIST.parsePayload({
      ...BASE,
      view: 'cancelled',
      q: ID,
      filters: {
        requestedBy: 'admin',
        cancelReason: 'sign-in',
        scheduledBefore: '2026-12-01T00:00Z',
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...BASE,
        view: 'cancelled',
        q: ID.toLowerCase(),
        filters: {
          requestedBy: 'admin',
          cancelReason: 'sign-in',
          scheduledBefore: '2026-12-01T00:00:00Z',
        },
      },
    });
    if (result.ok) expect(LIST.parsePayload(result.value)).toEqual(result);
  });

  it.each([
    [{ ...BASE, status: 'pending' }, 'payload.status', 'unknown'],
    [{ ...BASE, filters: { status: 'pending' } }, 'payload.filters.status', 'unknown'],
    [{ ...BASE, filters: { name: 'x' } }, 'payload.filters.name', 'unknown'],
    [{ ...BASE, v: 2 }, 'payload.v', 'value'],
    [{ ...BASE, view: 'open' }, 'payload.view', 'value'],
    [{ ...BASE, sort: 'name' }, 'payload.sort', 'value'],
    [{ ...BASE, direction: 'down' }, 'payload.direction', 'value'],
    [{ ...BASE, filters: { requestedBy: 'system' } }, 'payload.filters.requestedBy', 'value'],
    [{ ...BASE, q: 'someone@example.com' }, 'payload.q', 'format'],
    [{ ...BASE, filters: { from: 'yesterday' } }, 'payload.filters.from', 'format'],
  ])('refuses a document that is not one the list accepts (%#)', (payload, path, code) => {
    expect(fieldsOf(LIST.parsePayload(payload))).toContainEqual({ path, code });
  });
});
