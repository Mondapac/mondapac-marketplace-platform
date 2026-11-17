import { beforeEach, describe, expect, it, vi } from 'vitest';

// The packing slips loader (seller Orders, bulk print): it reads single orders the seller may see,
// at most SLIPS_MAX of them, and counts an order it cannot read as skipped. The session and the
// API reads are doubles; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  serverGet: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('./session.ts', () => ({ requireSession: mocks.requireSession }));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('./own-disputes.ts', () => ({ loadOwnDisputes: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadPackingSlips } from './orders-page.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const paid = (n: number, fulfilment = 'to-ship') => ({
  sellerOrderId: id(n),
  fulfilment,
  refunds: [],
  lines: [{ lineId: `l${n}`, quantity: 1 }],
});
const session = (over: Record<string, unknown> = {}) => ({
  kind: 'ok' as const,
  session: {
    sellerAccessState: 'approved',
    permissionKeys: ['ordering.seller-order.view'],
    ...over,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(session());
});

describe('loadPackingSlips', () => {
  it('reads each order once and returns the ones that still need sending', async () => {
    mocks.serverGet.mockImplementation((path: string) => {
      const n = Number(path.slice(-12));
      return Promise.resolve(
        n === 3 ? { kind: 'ok', body: paid(n, 'delivered') } : { kind: 'ok', body: paid(n) },
      );
    });
    const result = await loadPackingSlips([id(1), id(2), id(1), id(3)]);
    expect(mocks.serverGet).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.orders.map((o) => o.sellerOrderId)).toEqual([id(1), id(2)]);
      expect(result.skipped).toBe(1);
    }
  });

  it('reads at most 50 orders', async () => {
    mocks.serverGet.mockImplementation((path: string) =>
      Promise.resolve({ kind: 'ok', body: paid(Number(path.slice(-12))) }),
    );
    const result = await loadPackingSlips(Array.from({ length: 80 }, (_, n) => id(n + 1)));
    expect(mocks.serverGet).toHaveBeenCalledTimes(50);
    expect(result.kind === 'ok' && result.orders.length).toBe(50);
  });

  it('counts an order that cannot be read as skipped, whatever the reason', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'not-found' });
    const result = await loadPackingSlips([id(1), id(2)]);
    expect(result.kind === 'ok' && result.skipped).toBe(2);
    expect(result.kind === 'ok' && result.unreadable).toBe(0);
  });

  it('counts a failed read apart from a missing slip, so the seller can retry', async () => {
    mocks.serverGet.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith(id(1))
          ? { kind: 'unavailable' }
          : path.endsWith(id(2))
            ? { kind: 'not-found' }
            : { kind: 'ok', body: paid(3) },
      ),
    );
    const result = await loadPackingSlips([id(1), id(2), id(3)]);
    expect(result.kind === 'ok' && [result.skipped, result.unreadable]).toEqual([1, 1]);
  });

  it('shows no access without the order view key, and reads nothing', async () => {
    mocks.requireSession.mockResolvedValue(session({ permissionKeys: [] }));
    const result = await loadPackingSlips([id(1)]);
    expect(result.kind).toBe('no-access');
    expect(mocks.serverGet).not.toHaveBeenCalled();
  });

  it('sends a signed-out read to the session-ended page', async () => {
    mocks.serverGet.mockResolvedValue({ kind: 'signed-out' });
    await expect(loadPackingSlips([id(1)])).rejects.toThrow('REDIRECT:/session-ended');
  });
});
