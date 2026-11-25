import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sizes of the one-page offer: the sell units are read for a seller who may view the catalog,
// name the rows (published label first) and order them; a failed read fails only the sizes. The
// API reads are doubles; redirect throws as Next's does.

const mocks = vi.hoisted(() => ({
  serverGet: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadOfferSizes } from './offer-sizes.ts';
import type { OfferView } from '../catalog/types.ts';

const OFFER = { offerId: 'o1', productId: 'p1', sellerSku: 'RICE' };
const unit = (n: number, over: Record<string, unknown> = {}) => ({
  variantId: `v${n}`,
  variantNo: n,
  variantCode: `MP-000001-0${n}`,
  state: 'published',
  label: null,
  selling: true,
  variantSku: null,
  displaySku: `RICE-${n}`,
  ...over,
});
const UNITS = {
  productScope: 'PLATFORM',
  sellerSku: 'RICE',
  units: [unit(1, { label: '1 kg' }), unit(2)],
};

const reads = (over: Record<string, unknown> = {}) => {
  const answers: Record<string, unknown> = {
    'catalog/seller/offers/o1/sell-units': { kind: 'ok', body: UNITS },
    ...over,
  };
  mocks.serverGet.mockImplementation((path: string) =>
    Promise.resolve(answers[path] ?? { kind: 'not-found' }),
  );
};
let keys: string[] = [];
const load = () => loadOfferSizes(OFFER as unknown as OfferView, keys, 'en', (n) => `Size ${n}`);

beforeEach(() => {
  vi.clearAllMocks();
  keys = ['catalog.own-product.view'];
});

const ok = <T>(value: T | 'unavailable'): T => {
  if (value === 'unavailable') throw new Error('expected the sizes');
  return value;
};

describe('loadOfferSizes', () => {
  it('names the rows by the published label, else by position, and keeps the units', async () => {
    reads();
    const sizes = ok(await load());
    expect(sizes.rows.map((row) => [row.variantId, row.label])).toEqual([
      ['v1', '1 kg'],
      ['v2', 'Size 2'],
    ]);
    expect(sizes.rows[1]?.unit?.displaySku).toBe('RICE-2');
    expect(sizes.units).toEqual({ productScope: 'PLATFORM', sellerSku: 'RICE' });
  });

  it('does not read the units without the catalog view key', async () => {
    keys = ['pricing.price.view'];
    reads({
      'pricing/seller/offers/o1/prices': { kind: 'ok', body: { currency: 'AUD', variants: [] } },
    });
    expect(ok(await load()).units).toBeNull();
    expect(mocks.serverGet).not.toHaveBeenCalledWith('catalog/seller/offers/o1/sell-units');
  });

  it('reads nothing for a seller who may see none of it', async () => {
    keys = [];
    reads();
    expect(ok(await load()).rows).toEqual([]);
    expect(mocks.serverGet).not.toHaveBeenCalled();
  });

  it('answers unavailable (not the whole page) when a read fails or is not found', async () => {
    reads({ 'catalog/seller/offers/o1/sell-units': { kind: 'unavailable' } });
    expect(await load()).toBe('unavailable');
    reads({ 'catalog/seller/offers/o1/sell-units': { kind: 'not-found' } });
    expect(await load()).toBe('unavailable');
    keys = ['catalog.own-product.view', 'inventory.stock.view'];
    reads({ 'inventory/seller/sources': { kind: 'unavailable' } });
    expect(await load()).toBe('unavailable');
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    reads({ 'catalog/seller/offers/o1/sell-units': { kind: 'signed-out' } });
    await expect(load()).rejects.toThrow('REDIRECT:/session-ended');
  });
});
