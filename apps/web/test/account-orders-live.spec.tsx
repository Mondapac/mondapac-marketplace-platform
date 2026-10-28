// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AccountArea } from '../src/account/account-area.tsx';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { accountOrderOf } from '../src/account/live-orders.ts';
import { OrderDetails } from '../src/account/order-details.tsx';
import { AccountOrders } from '../src/account/orders.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { loadAccount } from '../src/storefront/source.ts';
import type { AccountOrder } from '../src/storefront/types.ts';

// The account's orders on real data: the pages link a real order by its id, its page shows what
// the API holds (no cancel, no "not charged" claim, no GST line without a tax record) and Buy
// again sends each sell unit to the real cart.

vi.mock('next/navigation', () => ({
  usePathname: () => '/account/orders',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const ORDER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VARIANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer>;
let calls: { method: string; path: string; body: unknown }[];
const fetchMock = vi.fn((url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = url.replace(/^\/api\//, '');
  calls.push({
    method,
    path,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  });
  const { status, body } = answers[`${method} ${path}`] ?? { status: 404, body: {} };
  return Promise.resolve(
    new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

const aud = (amount: string) => ({ amount, currency: 'AUD' });
const body = (extra: object = {}) => ({
  orderId: ORDER,
  status: 'confirmed',
  confirmedAt: '2026-10-20T23:30:00.000Z',
  tax: aud('341'),
  sellerNotes: {},
  sellerOrders: [
    {
      sellerId: SELLER,
      storeName: 'Halal Corner',
      fulfilment: 'shipped',
      deliveredAt: null,
      deliveryMethod: 'instant',
      shipping: aud('750'),
      lines: [
        {
          offerId: OFFER,
          variantId: VARIANT,
          quantity: 2,
          unitPrice: aud('1250'),
          productName: 'Lamb mince',
          variantLabel: '500 g',
        },
      ],
    },
  ],
  ...extra,
});
const LABELS = { unnamedItem: 'Item no longer listed', unnamedSeller: 'Seller' };
const real = (extra: object = {}, to = 'Jo Citizen: 1 Main St, Kedron QLD 4031') =>
  accountOrderOf(body(extra), LABELS, to) as AccountOrder;

beforeEach(() => {
  calls = [];
  answers = {
    'GET identity/customer/session': {
      status: 200,
      body: { accountId: 'a1', email: 'jo@example.com', displayName: 'Jo', csrfToken: 'csrf-1' },
    },
    'GET customers/me/addresses': { status: 200, body: { addresses: [], limit: 10 } },
    'GET cart/saved': { status: 200, body: { items: [] } },
    'GET cart': { status: 200, body: { groups: [], lineCount: 0 } },
    'POST cart/items': { status: 201, body: {} },
  };
  forgetCsrfToken();
  vi.stubGlobal('fetch', fetchMock);
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sample = await loadAccount();

function renderLive(orders: readonly AccountOrder[], children: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live initialLiveCart={null}>
        <main>
          <AccountArea source={{ ...sample, live: true, orders }}>{children}</AccountArea>
        </main>
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('orders list', () => {
  it('links a real order by its id and shows its short reference', async () => {
    renderLive([real()], <AccountOrders />);
    const link = await screen.findByRole('link', { name: /View order 3F2504E0/ });
    expect(link.getAttribute('href')).toBe(`/account/orders/${ORDER}`);
  });
});

describe('order page', () => {
  it('shows the parts, address and GST of the order the server read, and no cancel', async () => {
    renderLive([], <OrderDetails reference={ORDER} order={real()} />);
    const page = await screen.findByRole('main');
    expect(await within(page).findByText('Order 3F2504E0')).toBeTruthy();
    expect(within(page).getByText('Halal Corner')).toBeTruthy();
    expect(within(page).getByText('Lamb mince, 500 g')).toBeTruthy();
    expect(within(page).getByText('Jo Citizen: 1 Main St, Kedron QLD 4031')).toBeTruthy();
    expect(within(page).getByText('Prices include GST. Includes A$3.41 GST.')).toBeTruthy();
    expect(within(page).queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });

  it('says nothing about charges on a cancelled order, and no GST without a tax record', async () => {
    renderLive(
      [],
      <OrderDetails reference={ORDER} order={real({ status: 'cancelled', tax: null }, '')} />,
    );
    const page = await screen.findByRole('main');
    expect(await within(page).findByText('Order 3F2504E0')).toBeTruthy();
    expect(within(page).queryByText(/Your card was not charged/)).toBeNull();
    expect(within(page).queryByText(/Includes .* GST/)).toBeNull();
    expect(within(page).queryByRole('heading', { name: 'Delivered to' })).toBeNull();
  });

  it('Buy again adds each sell unit to the real cart', async () => {
    renderLive([], <OrderDetails reference={ORDER} order={real()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Buy again' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST' && c.path === 'cart/items')).not.toEqual([]),
    );
    const adds = calls.filter((c) => c.method === 'POST' && c.path === 'cart/items');
    expect(adds[0]?.body).toEqual(expect.objectContaining({ offerId: OFFER, variantId: VARIANT }));
  });
});
