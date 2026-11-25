// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { OffersList } from './offers-list.tsx';
import type { OfferListPage, OfferListRow } from './types.ts';

// Editing prices and stock right in the Offer list (Offer page PR 8): the page reads, the cells
// of one size, the sizes opened under their Offer, and "Save N changes".

const call = vi.mocked(callApi);
const O1 = '0190a000-0000-7000-8000-000000000001';
const O2 = '0190a000-0000-7000-8000-000000000002';
const V1 = '0190a000-0000-7000-8000-0000000000a1';
const V2 = '0190a000-0000-7000-8000-0000000000a2';
const V3 = '0190a000-0000-7000-8000-0000000000a3';
const S1 = '0190a000-0000-7000-8000-0000000000c1';
const ALL = [
  'catalog.offer.view',
  'pricing.price.view',
  'pricing.price.edit',
  'inventory.stock.view',
  'inventory.stock.edit',
];

const row = (offerId: string, name: string): OfferListRow => ({
  offerId,
  productId: '0190a000-0000-7000-8000-0000000000b1',
  product: {
    productCode: null,
    typeCode: 'grocery',
    name,
    scope: 'PLATFORM',
    primaryImageId: null,
  },
  sellerSku: name,
  conditionCode: 'new',
  description: {},
  status: 'published',
  listed: true,
  offSaleCauses: [],
  handling: null,
  attestationRecorded: false,
  submittedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-10-14T10:00:00.000Z',
  version: 1,
  actions: [],
});
const page: OfferListPage = {
  items: [row(O1, 'Beef mince'), row(O2, 'Beef rump steak')],
  total: null,
  page: 1,
  pageSize: 25,
  paging: 'prev-next',
  hasNext: false,
  counts: { draft: 0, pendingFirstPublish: 0, changesNeeded: 0, published: 2, all: 2 },
};
const price = (variantId: string, amount: string) => ({
  variantId,
  seriesVersion: 4,
  currency: 'AUD',
  inForce: { amount, effectiveFrom: '2026-11-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
});
const stock = (variantId: string, onHand: number) => ({
  variantId,
  sources: [{ variantId, sourceId: S1, onHand, held: 0, version: 2, retired: false }],
});
const PRICES = {
  currency: 'AUD',
  offers: [
    { offerId: O1, variants: [price(V1, '1790')] },
    { offerId: O2, variants: [price(V2, '1790'), price(V3, '950')] },
  ],
};
const STOCK = {
  offers: [
    { offerId: O1, variants: [stock(V1, 3)] },
    { offerId: O2, variants: [stock(V2, 25), stock(V3, 40)] },
  ],
};
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });

function serve(over: Record<string, unknown> = {}) {
  call.mockImplementation(((method: string, path: string) => {
    for (const [prefix, answer] of Object.entries(over)) {
      if (path.startsWith(prefix)) return Promise.resolve(answer);
    }
    if (method === 'PUT')
      return Promise.resolve(ok({ status: 'accepted', seriesVersion: 5, version: 3 }));
    if (path.startsWith('pricing/seller/offer-prices')) return Promise.resolve(ok(PRICES));
    if (path.startsWith('inventory/seller/offer-stock')) return Promise.resolve(ok(STOCK));
    if (path.endsWith('/sell-units')) {
      return Promise.resolve(
        ok({
          productScope: 'PLATFORM',
          sellerSku: 'X',
          units: [
            {
              variantId: V2,
              variantNo: 1,
              variantCode: 'a',
              state: 'published',
              label: '500 g',
              selling: true,
              variantSku: null,
              displaySku: 'X-1',
            },
            {
              variantId: V3,
              variantNo: 2,
              variantCode: 'b',
              state: 'published',
              label: '250 g',
              selling: true,
              variantSku: null,
              displaySku: 'X-2',
            },
          ],
        }),
      );
    }
    return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
  }) as never);
}
const mount = (keys: readonly string[] = ALL) =>
  render(
    <NextIntlClientProvider locale="en-AU" timeZone="UTC" messages={messages}>
      <OffersList
        initial={page}
        paging="prev-next"
        accountId="0190a000-0000-7000-8000-0000000000f1"
        marketId="AU"
        csrfToken="csrf"
        permissionKeys={keys}
        timeZone={null}
      />
    </NextIntlClientProvider>,
  );
const puts = () => call.mock.calls.filter(([method]) => method === 'PUT');

beforeEach(() => {
  call.mockReset();
  window.localStorage.clear();
  serve();
});
afterEach(cleanup);

describe('prices and stock in the Offer list', () => {
  it('reads the prices and stock of the whole page in one request each', async () => {
    mount();

    expect((await screen.findByLabelText<HTMLInputElement>('Price of Beef mince')).value).toBe(
      '17.90',
    );
    const reads = call.mock.calls.map(([, path]) => path);
    expect(reads).toContain(`pricing/seller/offer-prices?offerIds=${O1},${O2}`);
    expect(reads).toContain(`inventory/seller/offer-stock?offerIds=${O1},${O2}`);
    expect(screen.getByLabelText<HTMLInputElement>('Stock of Beef mince').value).toBe('3');
  });

  it('shows the price range and total stock of an Offer with several sizes, and no field', async () => {
    mount();
    await screen.findByLabelText('Price of Beef mince');

    expect(screen.getByText('$9.50 – $17.90')).toBeTruthy();
    expect(screen.getByText('65')).toBeTruthy();
    expect(screen.queryByLabelText('Price of Beef rump steak')).toBeNull();
    expect(screen.getByRole('button', { name: '2 sizes' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('saves nothing while typing, then sends each changed cell with Save N changes', async () => {
    mount();
    const priceField = await screen.findByLabelText('Price of Beef mince');

    fireEvent.change(priceField, { target: { value: '16.90' } });
    fireEvent.change(screen.getByLabelText('Stock of Beef mince'), { target: { value: '60' } });

    expect(puts()).toEqual([]);
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText(/Beef mince: price \$17\.90 → \$16\.90/)).toBeTruthy();
    act(() => {
      fireEvent.click(within(bar).getByRole('button', { name: 'Save 2 changes' }));
    });

    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[0]).toEqual([
      'PUT',
      `pricing/seller/offers/${O1}/variants/${V1}/regular-price`,
      { amount: '1690', currency: 'AUD', expectedVersion: 4 },
      'csrf',
    ]);
    expect(puts()[1]?.[1]).toBe(`inventory/seller/offers/${O1}/variants/${V1}/sources/${S1}/stock`);
    expect(puts()[1]?.[2]).toEqual({ onHand: 60, expectedVersion: 2 });
  });

  it('opens the sizes under their Offer, one Offer at a time, with their names', async () => {
    mount();
    await screen.findByLabelText('Price of Beef mince');

    fireEvent.click(screen.getByRole('button', { name: '2 sizes' }));

    const sizes = await screen.findByRole('table', { name: 'Sizes of Beef rump steak' });
    expect(screen.getByRole('button', { name: '2 sizes' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(await within(sizes).findByText('500 g')).toBeTruthy();
    const field = within(sizes).getByLabelText('Price for Beef rump steak, 250 g');
    expect((field as HTMLInputElement).value).toBe('9.50');
    fireEvent.change(field, { target: { value: '9.90' } });
    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '2 sizes' }));
    expect(screen.queryByRole('table', { name: 'Sizes of Beef rump steak' })).toBeNull();
    // A closed row keeps what was typed in it.
    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeTruthy();
  });

  it('keeps a bad value back with its message and sends the rest', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Price of Beef mince'), {
      target: { value: 'abc' },
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });

    expect(puts()).toEqual([]);
    expect(screen.getByLabelText('Price of Beef mince').getAttribute('aria-invalid')).toBe('true');
  });

  it('shows a refused write under its cell (stock below what is held)', async () => {
    serve({
      [`inventory/seller/offers/${O1}`]: {
        ok: false,
        failure: { status: 422, code: 'inventory.stock.below-held' },
      },
    });
    mount();
    fireEvent.change(await screen.findByLabelText('Stock of Beef mince'), {
      target: { value: '0' },
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });

    await waitFor(() =>
      expect(screen.getByLabelText('Stock of Beef mince').getAttribute('aria-invalid')).toBe(
        'true',
      ),
    );
  });

  it('shows the values without fields to a member who may only see them', async () => {
    mount(['catalog.offer.view', 'pricing.price.view', 'inventory.stock.view']);

    expect(await screen.findByText('$17.90')).toBeTruthy();
    expect(screen.queryByLabelText('Price of Beef mince')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('reads nothing and shows no price or stock column without the keys', async () => {
    mount(['catalog.offer.view']);
    await screen.findAllByText('Beef mince');

    expect(call.mock.calls.some(([, path]) => path.includes('offer-prices'))).toBe(false);
    expect(screen.queryByRole('columnheader', { name: 'Price' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Stock' })).toBeNull();
  });

  it('says so when the prices cannot be read, and offers no price field', async () => {
    serve({
      'pricing/seller/offer-prices': { ok: false, failure: { status: 503, code: 'x' } },
    });
    mount();

    expect(
      await screen.findByText(
        "Prices and stock can't be shown right now. Reload the page to try again.",
      ),
    ).toBeTruthy();
    // The stock still reads, so its field shows; the price cell is a dash, never an empty field.
    expect(await screen.findByLabelText('Stock of Beef mince')).toBeTruthy();
    expect(screen.queryByLabelText('Price of Beef mince')).toBeNull();
  });

  it('keeps the version a cell was typed at, and drops a cell changed elsewhere for retyping', async () => {
    let priceReads = 0;
    call.mockImplementation(((method: string, path: string) => {
      if (method === 'PUT' && path.includes('/regular-price')) {
        return Promise.resolve(
          priceReads === 1
            ? { ok: false, failure: { status: 409, code: 'conflict.stale' } }
            : ok({ status: 'accepted', seriesVersion: 10 }),
        );
      }
      if (method === 'PUT') return Promise.resolve(ok({ status: 'accepted', version: 3 }));
      if (path.startsWith('pricing/seller/offer-prices')) {
        priceReads += 1;
        // Someone else changes the price after the first read: the series moves to version 9.
        const [version, amount] = priceReads === 1 ? [4, '1790'] : [9, '1850'];
        return Promise.resolve(
          ok({
            ...PRICES,
            offers: [{ offerId: O1, variants: [{ ...price(V1, amount), seriesVersion: version }] }],
          }),
        );
      }
      if (path.startsWith('inventory/seller/offer-stock')) return Promise.resolve(ok(STOCK));
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }) as never);
    mount();
    fireEvent.change(await screen.findByLabelText('Price of Beef mince'), {
      target: { value: '16.90' },
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });

    // Refused as changed elsewhere: sent with the version it was typed at, then read again.
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Price of Beef mince').value).toBe('18.50'),
    );
    expect(screen.getByLabelText('Price of Beef mince').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Price of Beef mince'), { target: { value: '17.00' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });

    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts().map((put) => (put[2] as { expectedVersion: number }).expectedVersion)).toEqual([
      4, 9,
    ]);
  });

  it('keeps a value typed while a save runs, with the version it was typed at', async () => {
    let release: (value: unknown) => void = () => undefined;
    serve();
    const served = call.getMockImplementation();
    call.mockImplementation(((method: string, path: string, ...rest: unknown[]) => {
      if (method === 'PUT' && path.includes('/regular-price')) {
        return new Promise((resolve) => {
          release = () => resolve(ok({ status: 'accepted', seriesVersion: 5 }));
        });
      }
      return (served as (...args: unknown[]) => unknown)(method, path, ...rest);
    }) as never);
    mount();
    fireEvent.change(await screen.findByLabelText('Price of Beef mince'), {
      target: { value: '16.90' },
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });
    await waitFor(() => expect(puts()).toHaveLength(1));

    // Typed while the price is on its way: the stock draft survives the end of the save.
    fireEvent.change(screen.getByLabelText('Stock of Beef mince'), { target: { value: '7' } });
    await act(async () => {
      release(undefined);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]?.[2]).toEqual({ onHand: 7, expectedVersion: 2 });
  });

  it('counts only the sizes still sold when stock is not shown', async () => {
    serve({
      'pricing/seller/offer-prices': ok({
        currency: 'AUD',
        offers: [
          { offerId: O1, variants: [price(V1, '1790')] },
          { offerId: O2, variants: [price(V2, '1790'), { ...price(V3, '950'), retired: true }] },
        ],
      }),
    });
    mount(['catalog.offer.view', 'pricing.price.view', 'pricing.price.edit']);

    // One size is left, so it is edited in its row; no "2 sizes" toggle.
    expect(await screen.findByLabelText('Price of Beef rump steak')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sizes/ })).toBeNull();
  });

  it('shows whole units in a Market whose currency has no minor unit (JPY)', async () => {
    serve({
      'pricing/seller/offer-prices': ok({
        currency: 'JPY',
        offers: [{ offerId: O1, variants: [{ ...price(V1, '1790'), currency: 'JPY' }] }],
      }),
    });
    mount();

    const field = await screen.findByLabelText<HTMLInputElement>('Price of Beef mince');
    expect(field.value).toBe('1790');
    fireEvent.change(field, { target: { value: '1690' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    });

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.[2]).toEqual({ amount: '1690', currency: 'JPY', expectedVersion: 4 });
  });
});
