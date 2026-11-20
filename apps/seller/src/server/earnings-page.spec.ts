import { beforeEach, describe, expect, it, vi } from 'vitest';

// The earnings page loader: one failed payout read leaves the rest working, a failed ledger fails
// the page, and the account link follows the payout-account permission. The session and the API
// reads are doubles; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  serverGet: vi.fn(),
  loadOwnDisputes: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('./session.ts', () => ({ requireSession: mocks.requireSession }));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('./own-disputes.ts', () => ({ loadOwnDisputes: mocks.loadOwnDisputes }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadEarningsPage } from './earnings-page.ts';

const LEDGER = { sellerId: 's', currency: 'JPY', totals: {}, entries: [], nextCursor: null };
const NEXT = { slotAt: null, zone: null, estimatedAmount: null, blockReason: 'below-minimum' };
const HOLDS = { holds: [{ sellerOrderId: 'o', reason: 'holding-period' }] };
const HISTORY = {
  payouts: [],
  counts: {},
  total: null,
  page: null,
  pageSize: 25,
  nextCursor: null,
};

const session = (permissionKeys: string[]) => ({
  kind: 'signed-in' as const,
  session: { sellerAccessState: 'approved', permissionKeys },
});
const reads = (over: Record<string, unknown> = {}) => {
  const answers: Record<string, unknown> = {
    'commission-payouts/seller/ledger?limit=20': { kind: 'ok', body: LEDGER },
    'commission-payouts/seller/payouts/next': { kind: 'ok', body: NEXT },
    'commission-payouts/seller/payout-holds': { kind: 'ok', body: HOLDS },
    'commission-payouts/seller/payouts?limit=25': { kind: 'ok', body: HISTORY },
    ...over,
  };
  mocks.serverGet.mockImplementation((path: string) => {
    const hit = Object.entries(answers).find(([key]) => path.startsWith(key.split('?')[0]!));
    return Promise.resolve(hit === undefined ? { kind: 'not-found' } : hit[1]);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadOwnDisputes.mockResolvedValue([]);
  mocks.requireSession.mockResolvedValue(
    session(['commission-payouts.earnings.view', 'payments.payout-account.view']),
  );
});

describe('loadEarningsPage', () => {
  it('returns the ledger and all three payout sections when every read works', async () => {
    reads();
    const page = await loadEarningsPage();
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    expect(page.ledger).toEqual(LEDGER);
    expect(page.payouts).toEqual({
      next: NEXT,
      holds: HOLDS.holds,
      history: HISTORY,
      paging: 'prev-next',
      canOpenAccount: true,
    });
  });

  it.each([
    ['next', 'commission-payouts/seller/payouts/next'],
    ['holds', 'commission-payouts/seller/payout-holds'],
    ['history', 'commission-payouts/seller/payouts?limit=25'],
  ] as const)('leaves the rest working when the %s read fails', async (section, path) => {
    reads({ [path]: { kind: 'unavailable' } });
    const page = await loadEarningsPage();
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    expect(page.ledger).toEqual(LEDGER);
    expect(page.payouts[section]).toBeNull();
    const others = (['next', 'holds', 'history'] as const).filter((key) => key !== section);
    for (const key of others) expect(page.payouts[key]).not.toBeNull();
  });

  it('answers unavailable when the ledger cannot be read, and redirects when signed out', async () => {
    reads({ 'commission-payouts/seller/ledger?limit=20': { kind: 'unavailable' } });
    expect(await loadEarningsPage()).toEqual({ kind: 'unavailable' });
    reads({ 'commission-payouts/seller/ledger?limit=20': { kind: 'signed-out' } });
    await expect(loadEarningsPage()).rejects.toThrow('REDIRECT:/session-ended');
  });

  it('reads the first payout page by the Market List paging setting', async () => {
    reads();
    await loadEarningsPage();
    const asked = (path: string) => mocks.serverGet.mock.calls.some(([called]) => called === path);
    // Not readable: Previous and next, latest payout day first on the API cursor.
    expect(asked('commission-payouts/seller/payouts?limit=25')).toBe(true);
    mocks.serverGet.mockClear();
    reads({ 'settings/seller/list-paging': { kind: 'ok', body: { listPaging: 'pages' } } });
    const page = await loadEarningsPage();
    expect(
      asked('commission-payouts/seller/payouts?sort=slot&direction=desc&page=1&pageSize=25'),
    ).toBe(true);
    expect(page.kind === 'ok' && page.payouts.paging).toBe('pages');
  });

  it('offers the payout account link only with the account permission', async () => {
    reads();
    mocks.requireSession.mockResolvedValue(session(['commission-payouts.earnings.view']));
    const page = await loadEarningsPage();
    expect(page.kind === 'ok' && page.payouts.canOpenAccount).toBe(false);
  });

  it('shows no-access without the earnings permission and reads nothing', async () => {
    mocks.requireSession.mockResolvedValue(session([]));
    const page = await loadEarningsPage();
    expect(page.kind).toBe('no-access');
    expect(mocks.serverGet).not.toHaveBeenCalled();
  });
});
