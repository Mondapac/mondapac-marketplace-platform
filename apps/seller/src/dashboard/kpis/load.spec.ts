import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SellerSession } from '../../server/session.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));
vi.mock('server-only', () => ({}));
vi.mock('../../server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { startSellerKpis } from './load.ts';

// The KPI reads are asked for only with the orders key, always for the period of the address, and
// a failed read is an in-place error, a rejected session a sign-in redirect.

const TODAY = '2026-11-23';
const session = (keys: string[]) => ({ permissionKeys: keys }) as unknown as SellerSession;

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ kind: 'ok', body: {} });
});

describe('startSellerKpis', () => {
  it('reads nothing without the orders key or the earnings key', () => {
    expect(startSellerKpis(session(['catalog.offer.view']), { id: '7d' }, TODAY)).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('asks for the period, the own health and the public category tree', async () => {
    const sources = startSellerKpis(
      session(['ordering.seller-order.view']),
      { id: 'month' },
      TODAY,
    );
    await Promise.all([sources?.kpis, sources?.health, sources?.categories]);
    expect(mocks.get).toHaveBeenCalledWith('reporting/seller/kpis?period=month');
    expect(mocks.get).toHaveBeenCalledWith('sellers/own-health');
    expect(mocks.get).toHaveBeenCalledWith('catalog/categories', { anonymous: true });
  });

  it('reads the net earnings and the next payout only with the earnings key, never with an id', async () => {
    const without = startSellerKpis(session(['ordering.seller-order.view']), { id: '7d' }, TODAY);
    expect(without?.netEarnings).toBeNull();
    expect(without?.nextPayout).toBeNull();
    mocks.get.mockClear();
    const sources = startSellerKpis(
      session(['ordering.seller-order.view', 'commission-payouts.earnings.view']),
      { id: '7d' },
      TODAY,
    );
    await Promise.all([sources?.netEarnings, sources?.nextPayout]);
    expect(mocks.get).toHaveBeenCalledWith('reporting/seller/net-earnings?period=7d');
    expect(mocks.get).toHaveBeenCalledWith('commission-payouts/seller/payouts/next');
  });

  it('gives a member with only the earnings key the earnings cards, and no sales read', async () => {
    const sources = startSellerKpis(
      session(['commission-payouts.earnings.view']),
      { id: '30d' },
      TODAY,
    );
    expect(sources?.kpis).toBeNull();
    expect(sources?.categories).toBeNull();
    await Promise.all([sources?.netEarnings, sources?.nextPayout, sources?.health]);
    const paths = mocks.get.mock.calls.map((call) => call[0] as string).sort();
    expect(paths).toEqual([
      'commission-payouts/seller/payouts/next',
      'reporting/seller/net-earnings?period=30d',
      'sellers/own-health',
    ]);
  });

  it('gives a member with only the orders key the sales cards and no earnings read', () => {
    const sources = startSellerKpis(session(['ordering.seller-order.view']), { id: '30d' }, TODAY);
    expect(sources?.kpis).not.toBeNull();
    expect(sources?.netEarnings).toBeNull();
    expect(sources?.nextPayout).toBeNull();
  });

  it('leaves the earnings cards out when the API refuses them', async () => {
    mocks.get.mockResolvedValue({ kind: 'forbidden' });
    const sources = startSellerKpis(
      session(['ordering.seller-order.view', 'commission-payouts.earnings.view']),
      { id: '7d' },
      TODAY,
    );
    expect(await sources?.netEarnings).toBeNull();
    expect(await sources?.nextPayout).toBeNull();
  });

  it('turns a failed read into an error widget and no category names', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    const sources = startSellerKpis(session(['ordering.seller-order.view']), { id: '7d' }, TODAY);
    expect(await sources?.kpis).toEqual({ kind: 'error' });
    expect(await sources?.categories).toBeNull();
  });

  it('sends a rejected session to sign-in', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    const sources = startSellerKpis(session(['ordering.seller-order.view']), { id: '7d' }, TODAY);
    await expect(sources?.kpis).rejects.toThrow('redirect:/session-ended');
  });

  it('reads a valid custom range with its days, and leaves the net earnings out (preset only)', async () => {
    const sources = startSellerKpis(
      session(['ordering.seller-order.view', 'commission-payouts.earnings.view']),
      { id: 'custom', from: '2026-09-01', to: '2026-11-23' },
      TODAY,
    );
    await sources?.kpis;
    expect(sources?.refused).toBe(false);
    expect(mocks.get).toHaveBeenCalledWith(
      'reporting/seller/kpis?period=custom&from=2026-09-01&to=2026-11-23',
    );
    expect(sources?.netEarnings).toBeNull();
    expect(sources?.nextPayout).not.toBeNull();
  });

  it('reads no figure for a custom range that is not valid', async () => {
    const sources = startSellerKpis(
      session(['ordering.seller-order.view']),
      { id: 'custom', from: '2024-01-01', to: '2026-11-23' },
      TODAY,
    );
    await sources?.health;
    expect(sources?.refused).toBe(true);
    expect(sources?.kpis).toBeNull();
    expect(sources?.categories).toBeNull();
    const paths = mocks.get.mock.calls.map((call) => call[0] as string);
    expect(paths.some((path) => path.startsWith('reporting/seller/kpis'))).toBe(false);
  });
});
