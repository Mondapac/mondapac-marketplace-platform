// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import type { PlatformProduct } from './add-offer-dialog.tsx';
import { ON_THE_PLATFORM_ROWS, OnThePlatform, panelSearchPath } from './on-the-platform.tsx';

// "On the platform" under the seller's Products list (Offer page design section 3, PR 2).

const call = vi.mocked(callApi);
const SEARCH = 'catalog/seller/products/platform-search';

const product = (n: number, over: Partial<PlatformProduct> = {}): PlatformProduct => ({
  productId: `0190aaaa-0000-7000-8000-00000000000${n}`,
  productCode: `P0000037${n}`,
  name: `Beef product ${n}`,
  brandName: 'Ranch Gold',
  categoryId: null,
  categoryName: 'Beef',
  variantCount: 2,
  alreadySelling: false,
  ...over,
});
const answer = (items: PlatformProduct[], total = items.length, notice: string | null = null) => ({
  items,
  total,
  page: 1,
  pageSize: 25,
  notice,
  barcodeResults: [],
});
const ok = <T,>(body: T) => Promise.resolve({ ok: true as const, status: 200, body } as never);
const refused = (status: number, code: string) =>
  Promise.resolve({ ok: false as const, failure: { status, code } } as never);

function serve(search: () => Promise<never>, create?: () => Promise<never>) {
  call.mockImplementation((method, path) => {
    if (path.startsWith(SEARCH)) return search();
    if (path === 'catalog/seller/products/options') return ok({ conditions: ['used', 'new'] });
    if (method === 'POST' && path === 'catalog/seller/offers' && create) return create();
    return refused(500, 'unexpected');
  });
}

function mount(text = 'beef') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OnThePlatform text={text} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

const region = () => screen.findByRole('region', { name: /On the platform/ });

beforeEach(() => {
  call.mockReset();
  router.push.mockReset();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('On the platform', () => {
  it('asks the Add offer search without the products already sold', () => {
    expect(panelSearchPath('beef')).toBe(`${SEARCH}?q=beef&notSelling=true`);
    expect(panelSearchPath('')).toBe(`${SEARCH}?notSelling=true`);
  });

  it('shows a few products with their own count, a note and Sell this on each row', async () => {
    serve(() =>
      ok(
        answer(
          [1, 2, 3, 4, 5, 6, 7].map((n) => product(n)),
          12,
        ),
      ),
    );
    mount();
    const panel = within(await region());
    expect(
      panel.getByRole('heading', { name: 'On the platform: products you can sell (12)' }),
    ).toBeTruthy();
    expect(
      panel.getByText('Only your business activities · Not part of the table above'),
    ).toBeTruthy();
    expect(panel.getAllByRole('button', { name: /^Sell this: / })).toHaveLength(
      ON_THE_PLATFORM_ROWS,
    );
    expect(panel.getByText('Showing 5 of 12')).toBeTruthy();
    expect(panel.getAllByText('Ranch Gold · Beef · 2 sizes')).toHaveLength(ON_THE_PLATFORM_ROWS);
    // Not a list of its own: nothing to tick.
    expect(panel.queryByRole('checkbox')).toBeNull();
    expect(panel.getByRole('link', { name: 'Add your own product' }).getAttribute('href')).toBe(
      '/products/new',
    );
  });

  it.each([
    ['nothing is found', () => ok(answer([]))],
    ['the seller has no business activity', () => ok(answer([], 0, 'no-activity'))],
    ['the search fails', () => refused(503, 'access.unavailable')],
  ])('shows nothing when %s', async (_name, search) => {
    serve(search);
    mount();
    await waitFor(() => expect(call).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('creates a draft Offer with the default condition and opens it', async () => {
    serve(
      () => ok(answer([product(1)])),
      () => ok({ offerId: 'offer-9' }),
    );
    mount();
    fireEvent.click(
      within(await region()).getByRole('button', { name: 'Sell this: Beef product 1' }),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/offers/offer-9'));
    const post = call.mock.calls.find((entry) => entry[0] === 'POST');
    expect(post?.[2]).toEqual({
      productId: product(1).productId,
      sellerSku: 'P00000371',
      conditionCode: 'new',
      description: {},
    });
    expect(post?.[3]).toBe('csrf-1');
  });

  it('says on the row why a draft could not be created, and stays', async () => {
    serve(
      () => ok(answer([product(1), product(2)])),
      () => refused(409, 'offer.sku-taken'),
    );
    mount();
    fireEvent.click(
      within(await region()).getByRole('button', { name: 'Sell this: Beef product 1' }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The offer could not be created: you already use this product code as a SKU.',
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('See all opens the Add offer search with the same text', async () => {
    serve(() => ok(answer([product(1)])));
    mount('beef mince');
    fireEvent.click(
      within(await region()).getByRole('button', {
        name: 'See all platform products for “beef mince”',
      }),
    );
    const search = await screen.findByRole<HTMLInputElement>('searchbox', {
      name: 'Search the catalogue',
    });
    expect(search.value).toBe('beef mince');
  });

  it('follows a new search text', async () => {
    serve(() => ok(answer([product(1)])));
    const view = mount('beef');
    await region();
    view.rerender(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <OnThePlatform text="lamb" csrfToken="csrf-1" />
      </NextIntlClientProvider>,
    );
    await waitFor(() =>
      expect(call.mock.calls.map((entry) => entry[1])).toContain(
        `${SEARCH}?q=lamb&notSelling=true`,
      ),
    );
  });
});

describe('On the platform while a draft is created', () => {
  it('shows the busy row and holds the other rows', async () => {
    serve(
      () => ok(answer([product(1), product(2)])),
      () => new Promise<never>(() => undefined),
    );
    mount();
    const panel = within(await region());
    fireEvent.click(panel.getByRole('button', { name: 'Sell this: Beef product 1' }));
    await waitFor(() =>
      expect(
        panel.getByRole('button', { name: 'Sell this: Beef product 1' }).getAttribute('aria-busy'),
      ).toBe('true'),
    );
    expect(
      panel.getByRole<HTMLButtonElement>('button', { name: 'Sell this: Beef product 2' }).disabled,
    ).toBe(true);
  });
});
