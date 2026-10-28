// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { CartPage } from '../src/cart/cart-page.tsx';
import { liveCartOf, type LiveCart } from '../src/cart/live-cart.ts';
import { BuyControl } from '../src/product/buy-control.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import type { ProductOffer } from '../src/storefront/types.ts';

// The cart on real data (live mode): the screens show the API's cart, every change goes through
// the relay (`/api/cart...`) one at a time, and the cart is read again once nothing is waiting.

vi.mock('next/navigation', () => ({
  usePathname: () => '/cart',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock('../src/checkout/actions.ts', () => ({}));

const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VARIANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OFFER_B = '16fd2706-8baf-433b-82eb-8c7fada847da';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const LINE = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const LINE_B = 'a8098c1a-f86e-41a6-8c4b-2c4b3d5e6f70';
const SAVED = 'e02fd0e4-00fd-490a-9a3c-3f3d6c1b2a10';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}
type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer | (() => Answer)>;
let calls: Call[];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^\/api\//, '');
  calls.push({
    method,
    path,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  const answer = answers[`${method} ${path}`] ?? { status: 404, body: { code: 'not-found' } };
  const { status, body } = typeof answer === 'function' ? answer() : answer;
  return Promise.resolve(
    new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

const aud = (amount: string) => ({ amount, currency: 'AUD' });
const line = (quantity: number, extra: object = {}) => ({
  lineId: LINE,
  offerId: OFFER,
  variantId: VARIANT,
  quantity,
  state: 'buyable',
  reason: null,
  unitPrice: aud('1250'),
  previousPrice: null,
  availability: { status: 'in-stock', onlyLeft: null },
  display: { productId: null, productName: 'Lamb mince', variantLabel: '500 g', imageId: null },
  ...extra,
});
const cartBody = (...lines: object[]) => ({
  groups:
    lines.length === 0
      ? []
      : [
          {
            sellerId: SELLER,
            sellerName: 'Halal Corner',
            subtotal: aud('0'),
            minimumOrder: { state: 'none', minimum: null },
            deliveryFee: aud('750'),
            lines,
          },
        ],
  lineCount: lines.length,
});
const ok = (body: object): Answer => ({ status: 200, body });
const signedOut: Answer = { status: 401, body: { code: 'access.unauthenticated' } };
const session: Answer = ok({ email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' });

beforeEach(() => {
  calls = [];
  answers = { 'GET identity/customer/session': signedOut };
  forgetCsrfToken();
  vi.stubGlobal('fetch', fetchMock);
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderLive(initial: LiveCart | null, children = <CartPage />) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live initialLiveCart={initial}>
        <main>{children}</main>
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}
const called = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);
const main = () => screen.getByRole('main');
const shownQuantity = () =>
  within(main())
    .getByRole('group', { name: 'Quantity for Lamb mince, 500 g' })
    .querySelector('output')?.textContent;

describe('the real cart', () => {
  it("shows the server's cart, without the sample discount box", async () => {
    renderLive(liveCartOf(cartBody(line(2)), null));

    expect(await screen.findByRole('heading', { level: 2, name: 'Halal Corner' })).toBeTruthy();
    expect(within(main()).getByText('Lamb mince, 500 g')).toBeTruthy();
    expect(within(main()).queryByText('Have a discount code?')).toBeNull();
    expect(called('GET', 'cart')).toHaveLength(0);
  });

  it('reads the cart in the browser when the server could not', async () => {
    answers['GET cart'] = ok(cartBody(line(1)));
    renderLive(null);

    expect(await within(main()).findByText('Lamb mince, 500 g')).toBeTruthy();
  });

  it('sends a quantity change for the line, as a guest without a token, then reads the cart', async () => {
    answers['PUT cart/items/' + LINE] = ok({ lineId: LINE, quantity: 3, changed: true });
    answers['GET cart'] = ok(cartBody(line(3)));
    renderLive(liveCartOf(cartBody(line(2)), null));

    fireEvent.click(await screen.findByRole('button', { name: 'Increase quantity' }));

    await waitFor(() => expect(called('GET', 'cart')).toHaveLength(1));
    const [put] = called('PUT', `cart/items/${LINE}`);
    expect(put?.body).toEqual({ quantity: 3 });
    expect(put?.headers['x-csrf-token']).toBeUndefined();
    expect(shownQuantity()).toBe('3');
  });

  it('removes the line when its last unit goes', async () => {
    answers['DELETE cart/items/' + LINE] = ok({ removed: true });
    answers['GET cart'] = ok(cartBody());
    renderLive(liveCartOf(cartBody(line(1)), null));

    fireEvent.click(await screen.findByRole('button', { name: 'Decrease quantity' }));

    await waitFor(() => expect(called('GET', 'cart')).toHaveLength(1));
    expect(called('DELETE', `cart/items/${LINE}`)).toHaveLength(1);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Your cart is empty' }),
    ).toBeTruthy();
  });

  it('goes back to what the API holds when a change is refused', async () => {
    answers['PUT cart/items/' + LINE] = {
      status: 422,
      body: { code: 'cart.offer-not-purchasable' },
    };
    answers['GET cart'] = ok(cartBody(line(2)));
    renderLive(liveCartOf(cartBody(line(2)), null));

    fireEvent.click(await screen.findByRole('button', { name: 'Increase quantity' }));

    await waitFor(() => expect(called('GET', 'cart')).toHaveLength(1));
    await waitFor(() => expect(shownQuantity()).toBe('2'));
  });

  it('lists the lines that cannot be bought, and removes one', async () => {
    answers['DELETE cart/items/' + LINE_B] = ok({ removed: true });
    answers['GET cart'] = ok(cartBody(line(1)));
    renderLive(
      liveCartOf(
        cartBody(
          line(1),
          line(1, {
            lineId: LINE_B,
            offerId: OFFER_B,
            state: 'unavailable',
            reason: 'out-of-stock',
            unitPrice: null,
          }),
        ),
        null,
      ),
    );

    const section = (await screen.findByRole('heading', { name: /Not available right now/ }))
      .parentElement!;
    fireEvent.click(within(section).getByRole('button', { name: 'Remove Lamb mince, 500 g' }));

    await waitFor(() => expect(called('DELETE', `cart/items/${LINE_B}`)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /Not available right now/ })).toBeNull(),
    );
  });

  it('adds an offer of the product page by its sell unit', async () => {
    answers['POST cart/items'] = ok({ lineId: LINE, quantity: 1, changed: true });
    answers['GET cart'] = ok(cartBody(line(1)));
    const offer = {
      id: OFFER,
      variantId: VARIANT,
      price: { amount: 1250, currency: 'AUD' },
      seller: { name: 'Halal Corner' },
    } as unknown as ProductOffer;
    renderLive(liveCartOf(cartBody(), null), <BuyControl offer={offer} variant="wide" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add to cart' }));

    await waitFor(() => expect(called('GET', 'cart')).toHaveLength(1));
    expect(called('POST', 'cart/items')[0]?.body).toEqual({
      offerId: OFFER,
      variantId: VARIANT,
      quantity: 1,
    });
    expect(within(main()).getByText('1')).toBeTruthy();
  });
});

describe('saved for later, signed in', () => {
  it('moves a line to the account list through the API and back', async () => {
    const savedBody = {
      items: [
        {
          ...line(1),
          savedId: SAVED,
          savedAt: '2026-10-27T00:00:00Z',
          sellerId: SELLER,
          sellerName: 'Halal Corner',
        },
      ],
    };
    answers = {
      'GET identity/customer/session': session,
      'GET customers/me/addresses': ok({ addresses: [], limit: 10 }),
      'GET cart/saved': ok({ items: [] }),
      'POST cart/saved': ok({ savedId: SAVED }),
      'GET cart': ok(cartBody()),
      [`POST cart/saved/${SAVED}/move-to-cart`]: ok({ lineId: LINE, quantity: 1 }),
    };
    renderLive(liveCartOf(cartBody(line(1)), null));
    await waitFor(() => expect(called('GET', 'cart/saved')).toHaveLength(1));
    answers['GET cart/saved'] = ok(savedBody);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Save Lamb mince, 500 g for later' }),
    );

    await waitFor(() => expect(called('GET', 'cart/saved')).toHaveLength(2));
    const [save] = called('POST', 'cart/saved');
    expect(save?.body).toEqual({ lineId: LINE });
    expect(save?.headers['x-csrf-token']).toBe('csrf-1');
    const saved = (await screen.findByRole('heading', { name: /Saved for later/ })).parentElement!;
    expect(within(saved).getByText('Halal Corner')).toBeTruthy();

    answers['GET cart'] = ok(cartBody(line(1)));
    answers['GET cart/saved'] = ok({ items: [] });
    fireEvent.click(within(saved).getByRole('button', { name: 'Move Lamb mince, 500 g to cart' }));

    await waitFor(() => expect(called('POST', `cart/saved/${SAVED}/move-to-cart`)).toHaveLength(1));
    expect(await screen.findByRole('heading', { level: 2, name: 'Halal Corner' })).toBeTruthy();
  });
});
