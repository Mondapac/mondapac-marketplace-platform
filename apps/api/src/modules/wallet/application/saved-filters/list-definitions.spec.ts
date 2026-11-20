import { WALLET_LISTS } from './list-definitions';
import { WALLET_CREDIT_VIEW, WALLET_SAVED_FILTER_SHARE } from '../../contracts/permissions';
import { ListAdminCreditRequests } from '../use-cases/list-admin-credit-requests.use-case';

// The saved-filter document of the admin Credit requests list (super list phase 4, PR10): closed
// and versioned, read by the list's own selector, stored in canonical form; `requestedBy=me`
// stays `me`, so a shared filter means whoever opens it.

const ID = '01990000-0000-7000-8000-00000000C001';
const [LIST] = WALLET_LISTS;
if (LIST === undefined) throw new Error('missing list');
const fieldsOf = (result: ReturnType<typeof LIST.parsePayload>) =>
  result.ok ? null : result.error.fields;
const BASE = { v: 1, view: 'all', sort: 'requested', direction: 'desc' } as const;

describe('the wallet saved-filter list', () => {
  it('is guarded by the key the list use case checks and shared with the module key', () => {
    expect(LIST.listKey).toBe('admin.wallet.credit-requests');
    expect(LIST.population).toBe('admin');
    expect(LIST.viewKey).toBe(WALLET_CREDIT_VIEW.key);
    expect(ListAdminCreditRequests.access.rule).toEqual({
      kind: 'permissions',
      allOf: [LIST.viewKey],
    });
    expect(LIST.shareKey).toBe(WALLET_SAVED_FILTER_SHARE.key);
  });

  it('keeps a document in its canonical form, with `me` kept as the word', () => {
    const result = LIST.parsePayload({
      ...BASE,
      q: ID,
      filters: { requestedBy: 'me', minAmount: '500', maxAmount: '00900' },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        ...BASE,
        q: ID.toLowerCase(),
        filters: { requestedBy: 'me', minAmount: '500', maxAmount: '900' },
      },
    });
    if (result.ok) expect(LIST.parsePayload(result.value)).toEqual(result);
    expect(LIST.parsePayload({ ...BASE, filters: { requestedBy: ID } })).toEqual({
      ok: true,
      value: { ...BASE, filters: { requestedBy: ID.toLowerCase() } },
    });
  });

  it.each([
    [{ ...BASE, limit: 20 }, 'payload.limit', 'unknown'],
    [{ ...BASE, filters: { view: 'all' } }, 'payload.filters.view', 'unknown'],
    [{ ...BASE, v: 0 }, 'payload.v', 'value'],
    [{ ...BASE, view: 'open' }, 'payload.view', 'value'],
    [{ ...BASE, sort: 'created' }, 'payload.sort', 'value'],
    [{ ...BASE, direction: null }, 'payload.direction', 'value'],
    [{ ...BASE, filters: { reason: 'gift' } }, 'payload.filters.reason', 'value'],
    [{ ...BASE, filters: { requestedBy: 'you' } }, 'payload.filters.requestedBy', 'format'],
    [{ ...BASE, filters: { minAmount: '-1' } }, 'payload.filters.minAmount', 'format'],
    [
      { ...BASE, filters: { minAmount: '9', maxAmount: '1' } },
      'payload.filters.maxAmount',
      'range',
    ],
  ])('refuses a document that is not one the list accepts (%#)', (payload, path, code) => {
    expect(fieldsOf(LIST.parsePayload(payload))).toContainEqual({ path, code });
  });

  it('refuses a status the saved view does not show', () => {
    const pendingOnly = LIST.parsePayload({
      ...BASE,
      view: 'granted',
      filters: { status: 'pending' },
    });
    expect(fieldsOf(pendingOnly)).toEqual([
      { path: 'payload.filters.status', code: 'outside-view' },
    ]);
  });
});
