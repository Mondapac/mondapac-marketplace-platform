// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const sellName = (n: number) => `Sell this: Beef product ${n} by Ranch Gold, P0000037${n}`;
const rerenderWith = (view: ReturnType<typeof mount>, text: string) =>
  view.rerender(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OnThePlatform text={text} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
const location = { assign: vi.fn() };

describe('On the platform', () => {
  beforeEach(() => {
    location.assign.mockReset();
    vi.stubGlobal('location', location);
  });
  afterEach(() => vi.unstubAllGlobals());

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
      panel.getByText('From your business activities only. Not part of the list above.'),
    ).toBeTruthy();
    expect(panel.getAllByRole('button', { name: /^Sell this: / })).toHaveLength(
      ON_THE_PLATFORM_ROWS,
    );
    expect(panel.getByRole('button', { name: sellName(1) })).toBeTruthy();
    expect(panel.getByText('Showing 5 of 12')).toBeTruthy();
    expect(panel.getAllByText('Ranch Gold · Beef · 2 sizes')).toHaveLength(ON_THE_PLATFORM_ROWS);
    // Not a list of its own: nothing to tick.
    expect(panel.queryByRole('checkbox')).toBeNull();
    expect(panel.getByRole('link', { name: 'Add your own product' }).getAttribute('href')).toBe(
      '/products/new',
    );
  });

  it('names a product without a brand by its name and code', async () => {
    serve(() => ok(answer([product(1, { brandName: null })])));
    mount();
    expect(
      within(await region()).getByRole('button', { name: 'Sell this: Beef product 1, P00000371' }),
    ).toBeTruthy();
  });

  it.each([
    ['nothing is found', () => ok(answer([]))],
    ['the seller has no business activity', () => ok(answer([], 0, 'no-activity'))],
    ['the search fails', () => refused(503, 'access.unavailable')],
  ])('shows nothing when %s', async (_name, other) => {
    // Shown for "beef" first, so the panel's disappearing is what is checked.
    call.mockImplementation((_method, path) =>
      path === panelSearchPath('beef') ? ok(answer([product(1)])) : other(),
    );
    const view = mount('beef');
    await region();
    rerenderWith(view, 'nothing');
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull());
  });

  it('creates a draft Offer with the default condition and opens it', async () => {
    serve(
      () => ok(answer([product(1)])),
      () => ok({ offerId: 'offer-9' }),
    );
    mount();
    const button = within(await region()).getByRole('button', { name: sellName(1) });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/offers/offer-9'));
    const posts = call.mock.calls.filter((entry) => entry[0] === 'POST');
    // A double click creates one draft.
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[2]).toEqual({
      productId: product(1).productId,
      sellerSku: 'P00000371',
      conditionCode: 'new',
      description: {},
    });
    expect(posts[0]?.[3]).toBe('csrf-1');
  });

  it('says on the row why a draft could not be created, and stays', async () => {
    serve(
      () => ok(answer([product(1), product(2)])),
      () => refused(409, 'offer.sku-taken'),
    );
    mount();
    fireEvent.click(within(await region()).getByRole('button', { name: sellName(1) }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'The offer could not be created: you already use this product code as a SKU.',
    );
    expect(screen.getByRole('button', { name: sellName(1) }).getAttribute('aria-describedby')).toBe(
      alert.id,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('cannot sell twice a product the seller turned out to sell already', async () => {
    serve(
      () => ok(answer([product(1)])),
      () => refused(409, 'offer.exists-for-product'),
    );
    mount();
    fireEvent.click(within(await region()).getByRole('button', { name: sellName(1) }));
    await screen.findByRole('alert');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: sellName(1) }).disabled).toBe(
      true,
    );
  });

  it("says so on the row when the shop's settings cannot be read, and frees the buttons", async () => {
    call.mockImplementation((_method, path) =>
      path.startsWith(SEARCH)
        ? ok(answer([product(1), product(2)]))
        : refused(503, 'access.unavailable'),
    );
    mount();
    fireEvent.click(within(await region()).getByRole('button', { name: sellName(1) }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "The offer could not be created: we couldn't get your shop's settings, try again.",
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: sellName(2) }).disabled).toBe(
      false,
    );
    expect(call.mock.calls.some((entry) => entry[0] === 'POST')).toBe(false);
  });

  it.each([
    ['the search', 'search'],
    ['the settings read', 'options'],
    ['the create', 'create'],
  ])('ends the session when %s answers 401', async (_name, step) => {
    call.mockImplementation((method, path) => {
      if (path.startsWith(SEARCH)) {
        return step === 'search' ? refused(401, 'session.invalid') : ok(answer([product(1)]));
      }
      if (path === 'catalog/seller/products/options') {
        return step === 'options' ? refused(401, 'session.invalid') : ok({ conditions: ['new'] });
      }
      return method === 'POST' ? refused(401, 'session.invalid') : refused(500, 'unexpected');
    });
    mount();
    if (step !== 'search') {
      fireEvent.click(within(await region()).getByRole('button', { name: sellName(1) }));
    }
    await waitFor(() => expect(location.assign).toHaveBeenCalledWith('/session-ended'));
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

  it('dims the rows of the old text until the new one answers, and drops a late old answer', async () => {
    const pending: Record<string, (value: never) => void> = {};
    call.mockImplementation((_method, path) => {
      if (path === panelSearchPath('beef') && pending['first'] === undefined) {
        pending['first'] = () => undefined;
        return ok(answer([product(1)]));
      }
      return new Promise<never>((resolve) => {
        pending[path.includes('lamb') ? 'lamb' : 'beef-late'] = resolve;
      });
    });
    const view = mount('beef');
    const panel = await region();
    rerenderWith(view, 'lamb');
    // The old rows wait, dimmed, and cannot be sold.
    await waitFor(() => expect(panel.getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: sellName(1) }).disabled).toBe(
      true,
    );
    rerenderWith(view, 'beef');
    rerenderWith(view, 'lamb');
    // "lamb" answers; an older "beef" answer arriving after it is dropped.
    await act(() => {
      pending['lamb']?.({ ok: true, status: 200, body: answer([product(2)], 1) } as never);
      return Promise.resolve();
    });
    await act(() => {
      pending['beef-late']?.({ ok: true, status: 200, body: answer([product(3)], 1) } as never);
      return Promise.resolve();
    });
    const now = await region();
    expect(now.getAttribute('aria-busy')).toBe('false');
    expect(within(now).getByRole('button', { name: sellName(2) })).toBeTruthy();
    expect(within(now).queryByRole('button', { name: sellName(3) })).toBeNull();
  });
});

describe('On the platform while a draft is created', () => {
  it('shows the busy row and holds the other rows and links', async () => {
    serve(
      () => ok(answer([product(1), product(2)])),
      () => new Promise<never>(() => undefined),
    );
    mount();
    const panel = within(await region());
    fireEvent.click(panel.getByRole('button', { name: sellName(1) }));
    const busy = await panel.findByRole('button', {
      name: 'Creating a draft offer for Beef product 1',
    });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(panel.getByRole<HTMLButtonElement>('button', { name: sellName(2) }).disabled).toBe(true);
    expect(
      panel.getByRole<HTMLButtonElement>('button', { name: /^See all platform products/ }).disabled,
    ).toBe(true);
    expect(panel.queryByRole('link', { name: 'Add your own product' })).toBeNull();
  });
});
