import { beforeEach, describe, expect, it, vi } from 'vitest';

// The offer variants page loader: the sell units are read for a seller who may view the catalog,
// name the rows (published label first) and order them; a failed read fails the page. The session
// and the API reads are doubles; redirect throws as Next's does.

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
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { loadVariantsPage } from './variants-page.ts';

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

const session = (permissionKeys: string[]) => ({
  kind: 'signed-in' as const,
  session: { sellerAccessState: 'approved', permissionKeys },
});
const reads = (over: Record<string, unknown> = {}) => {
  const answers: Record<string, unknown> = {
    'catalog/seller/offers/o1/sell-units': { kind: 'ok', body: UNITS },
    'catalog/seller/offers/o1': { kind: 'ok', body: OFFER },
    ...over,
  };
  mocks.serverGet.mockImplementation((path: string) =>
    Promise.resolve(answers[path] ?? { kind: 'not-found' }),
  );
};
const load = () => loadVariantsPage('o1', 'en', (n) => `Variant ${n}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue(session(['catalog.own-product.view']));
});

describe('loadVariantsPage', () => {
  it('names the rows by the published label, else by position, and keeps the units', async () => {
    reads();
    const page = await load();
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    expect(page.rows.map((row) => [row.variantId, row.label])).toEqual([
      ['v1', '1 kg'],
      ['v2', 'Variant 2'],
    ]);
    expect(page.rows[1]?.unit?.displaySku).toBe('RICE-2');
    expect(page.units).toEqual({ productScope: 'PLATFORM', sellerSku: 'RICE' });
  });

  it('does not read the units without the catalog view key', async () => {
    mocks.requireSession.mockResolvedValue(session(['pricing.price.view']));
    reads({
      'pricing/seller/offers/o1/prices': { kind: 'ok', body: { currency: 'AUD', variants: [] } },
    });
    const page = await load();
    expect(page.kind).toBe('ok');
    if (page.kind === 'ok') expect(page.units).toBeNull();
    expect(mocks.serverGet).not.toHaveBeenCalledWith('catalog/seller/offers/o1/sell-units');
  });

  it('answers no-access for a seller who may view nothing of it', async () => {
    mocks.requireSession.mockResolvedValue(session([]));
    reads();
    expect((await load()).kind).toBe('no-access');
  });

  it('fails the page when the units cannot be read, and not-found when the offer is gone', async () => {
    reads({ 'catalog/seller/offers/o1/sell-units': { kind: 'unavailable' } });
    expect((await load()).kind).toBe('unavailable');
    reads({ 'catalog/seller/offers/o1/sell-units': { kind: 'not-found' } });
    expect((await load()).kind).toBe('not-found');
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    reads({ 'catalog/seller/offers/o1/sell-units': { kind: 'signed-out' } });
    await expect(load()).rejects.toThrow('REDIRECT:/session-ended');
  });
});
