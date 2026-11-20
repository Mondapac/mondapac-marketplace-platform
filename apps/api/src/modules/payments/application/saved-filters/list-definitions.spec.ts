import { PAYMENTS_LISTS } from './list-definitions';
import {
  PAYMENTS_CONNECTED_ACCOUNT_VIEW,
  PAYMENTS_SAVED_FILTER_SHARE,
} from '../../contracts/permissions';
import { AdminListConnectedAccounts } from '../use-cases/admin-list-connected-accounts.use-case';

// The saved-filter document of the admin Seller accounts list (super list phase 4, PR10): closed
// and versioned, no views, read by the list's own selector, stored in canonical form.

const ID = '01990000-0000-7000-8000-00000000B001';
const [LIST] = PAYMENTS_LISTS;
if (LIST === undefined) throw new Error('missing list');
const fieldsOf = (result: ReturnType<typeof LIST.parsePayload>) =>
  result.ok ? null : result.error.fields;
const BASE = { v: 1, sort: 'created', direction: 'desc' } as const;

describe('the payments saved-filter list', () => {
  it('is guarded by the key the list use case checks and shared with the module key', () => {
    expect(LIST.listKey).toBe('admin.payments.connected-accounts');
    expect(LIST.population).toBe('admin');
    expect(LIST.viewKey).toBe(PAYMENTS_CONNECTED_ACCOUNT_VIEW.key);
    expect(AdminListConnectedAccounts.access.rule).toEqual({
      kind: 'permissions',
      allOf: [LIST.viewKey],
    });
    expect(LIST.shareKey).toBe(PAYMENTS_SAVED_FILTER_SHARE.key);
  });

  it('keeps a document in its canonical form: a seller id or a store-name search as q', () => {
    const byId = LIST.parsePayload({
      ...BASE,
      q: ID,
      filters: { status: 'enabled', ready: 'no', waiting: 'paused', from: '2026-11-01T00:00:00Z' },
    });
    expect(byId).toEqual({
      ok: true,
      value: {
        ...BASE,
        q: ID.toLowerCase(),
        filters: {
          status: 'enabled',
          ready: 'no',
          waiting: 'paused',
          from: '2026-11-01T00:00:00Z',
        },
      },
    });
    if (byId.ok) expect(LIST.parsePayload(byId.value)).toEqual(byId);
    expect(LIST.parsePayload({ ...BASE, q: '  Corner Store ', filters: {} })).toEqual({
      ok: true,
      value: { ...BASE, q: 'Corner Store', filters: {} },
    });
  });

  it.each([
    [{ ...BASE, view: 'all' }, 'payload.view', 'unknown'],
    [{ ...BASE, paging: 'pages' }, 'payload.paging', 'unknown'],
    [{ ...BASE, filters: { sellerId: ID } }, 'payload.filters.sellerId', 'unknown'],
    [{ ...BASE, v: '1' }, 'payload.v', 'value'],
    [{ ...BASE, sort: 'amount' }, 'payload.sort', 'value'],
    [{ ...BASE, direction: 'DESC' }, 'payload.direction', 'value'],
    [{ ...BASE, filters: { ready: 'true' } }, 'payload.filters.ready', 'value'],
    [{ ...BASE, filters: { requirements: 'soon' } }, 'payload.filters.requirements', 'value'],
    [{ ...BASE, q: 'x' }, 'payload.q', 'length'],
    [{ ...BASE, filters: { from: '2026-11-01' } }, 'payload.filters.from', 'format'],
  ])('refuses a document that is not one the list accepts (%#)', (payload, path, code) => {
    expect(fieldsOf(LIST.parsePayload(payload))).toContainEqual({ path, code });
  });
});
