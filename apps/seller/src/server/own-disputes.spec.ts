import { beforeEach, describe, expect, it, vi } from 'vitest';

// The seller's dispute read and its use on the order page. The session and the API read are
// doubles; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  serverGet: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('./session.ts', () => ({ requireSession: mocks.requireSession }));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadOrderDetailPage } from './orders-page.ts';
import { loadOwnDisputes } from './own-disputes.ts';

const SO_1 = '0190a000-0000-7000-8000-0000000000a1';
const SO_2 = '0190a000-0000-7000-8000-0000000000a2';
const dispute = (sellerOrderId: string, over: Record<string, unknown> = {}) => ({
  sellerOrderId,
  orderId: '0190a000-0000-7000-8000-0000000000b9',
  since: '2026-10-20T01:00:00.000Z',
  open: true,
  recoveredAmount: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadOwnDisputes', () => {
  it('returns the disputes of an ok answer', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'ok', body: { disputes: [dispute(SO_1)] } });
    expect(await loadOwnDisputes()).toEqual([dispute(SO_1)]);
    expect(mocks.serverGet).toHaveBeenCalledWith('commission-payouts/seller/disputes');
  });

  it.each(['signed-out', 'forbidden', 'not-found', 'unavailable'])(
    'reads a %s answer as no notices, without throwing',
    async (kind) => {
      mocks.serverGet.mockResolvedValue({ kind });
      expect(await loadOwnDisputes()).toEqual([]);
    },
  );

  it('reads an ok answer without the disputes key as no notices', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'ok', body: {} });
    expect(await loadOwnDisputes()).toEqual([]);
  });
});

describe('loadOrderDetailPage dispute match', () => {
  const session = {
    sellerAccessState: 'approved',
    permissionKeys: ['ordering.seller-order.view'],
    csrfToken: 'csrf',
  };
  const answers = (disputes: unknown) =>
    mocks.serverGet.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('ordering/seller/orders/')
          ? { kind: 'ok', body: { sellerOrderId: SO_1 } }
          : { kind: 'ok', body: { disputes } },
      ),
    );

  it('picks the dispute of this seller order, not another one of the same seller', async () => {
    mocks.requireSession.mockResolvedValue({ kind: 'ok', session });
    answers([dispute(SO_2), dispute(SO_1, { open: false })]);
    const page = await loadOrderDetailPage(SO_1);
    expect(page).toMatchObject({ kind: 'ok', dispute: { sellerOrderId: SO_1, open: false } });
  });

  it('has no dispute when only other seller orders are disputed', async () => {
    mocks.requireSession.mockResolvedValue({ kind: 'ok', session });
    answers([dispute(SO_2)]);
    expect(await loadOrderDetailPage(SO_1)).toMatchObject({ kind: 'ok', dispute: null });
  });

  it('still shows the order when the dispute read fails', async () => {
    mocks.requireSession.mockResolvedValue({ kind: 'ok', session });
    mocks.serverGet.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('ordering/seller/orders/')
          ? { kind: 'ok', body: { sellerOrderId: SO_1 } }
          : { kind: 'unavailable' },
      ),
    );
    expect(await loadOrderDetailPage(SO_1)).toMatchObject({ kind: 'ok', dispute: null });
  });
});
