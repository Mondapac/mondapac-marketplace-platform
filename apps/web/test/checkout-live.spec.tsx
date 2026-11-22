// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { forgetCsrfToken } from '../src/account/customer-api.ts';
import { liveCartOf } from '../src/cart/live-cart.ts';
import { CheckoutPage } from '../src/checkout/checkout-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';

// Checkout on real data (live mode): the guest logs in for real, a new address is saved to the
// address book before delivery is priced, and Pay goes to the API through the relay. The sample
// Pay (the server action) is never called.

const push = vi.fn();
const { payOrder } = vi.hoisted(() => ({ payOrder: vi.fn() }));
vi.mock('../src/checkout/actions.ts', () => ({
  payOrder,
  deliveryAreaFor: () => Promise.resolve({ kind: 'in' }),
  deliveryOptionsFor: () => Promise.resolve({ kind: 'failed' }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/checkout',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push, replace: () => undefined }),
}));

const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VARIANT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const LINE = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const ADDRESS = 'e02fd0e4-00fd-490a-9a3c-3f3d6c1b2a10';
const NEW_ADDRESS = 'a8098c1a-f86e-41a6-8c4b-2c4b3d5e6f70';
const ORDER = '16fd2706-8baf-433b-82eb-8c7fada847da';
const QUOTE = '11111111-1111-4111-8111-111111111111';

const aud = (amount: string) => ({ amount, currency: 'AUD' });
const cart = liveCartOf(
  {
    groups: [
      {
        sellerId: SELLER,
        sellerName: 'Halal Corner',
        subtotal: aud('2500'),
        minimumOrder: { state: 'none', minimum: null },
        lines: [
          {
            lineId: LINE,
            offerId: OFFER,
            variantId: VARIANT,
            quantity: 2,
            state: 'buyable',
            reason: null,
            unitPrice: aud('1250'),
            previousPrice: null,
            availability: { status: 'in-stock', onlyLeft: null },
            display: {
              productId: null,
              productName: 'Lamb mince',
              variantLabel: null,
              imageId: null,
            },
          },
        ],
      },
    ],
    lineCount: 1,
  },
  null,
);
const address = (id: string, isDefault: boolean) => ({
  id,
  recipientFirstName: 'Jo',
  recipientLastName: 'Rahman',
  phone: '0400000000',
  line1: '12 Example Street',
  suburb: 'Kedron',
  region: 'QLD',
  postcode: '4031',
  isDefault,
});
const quotes = {
  sellers: [
    {
      sellerId: SELLER,
      zone: 'Australia/Brisbane',
      sameDayCutoff: '12:00',
      scheduledDaysAhead: 7,
      scheduledWindowMinutes: 120,
      pickupPostcode: null,
      methods: [
        {
          method: 'instant',
          available: true,
          reason: null,
          price: {
            state: 'quoted',
            quoteId: QUOTE,
            total: aud('990'),
            tax: aud('90'),
            etaMinutes: 40,
            validUntil: '2099-01-01T00:00:00Z',
          },
        },
      ],
    },
  ],
};

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer>;
let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  push.mockReset();
  payOrder.mockReset();
  forgetCsrfToken();
  answers = {
    'GET identity/customer/session': {
      status: 200,
      body: { email: 'jo@example.com', displayName: 'Jo Rahman', csrfToken: 'csrf-1' },
    },
    'GET customers/me/addresses': { status: 200, body: { addresses: [address(ADDRESS, true)] } },
    'GET cart/saved': { status: 200, body: { items: [] } },
    'POST orders/delivery-quotes': { status: 200, body: quotes },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
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
    }),
  );
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const source = { ...SAMPLE_CHECKOUT, areaCheck: 'api' as const };

function renderLive() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider live initialLiveCart={cart}>
        <main>
          <CheckoutPage source={source} />
        </main>
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const payButtons = () => screen.getAllByRole('button', { name: /^Pay A\$/ });
const posted = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

describe('live checkout', () => {
  it('asks a guest to log in for real, never with the sample form', async () => {
    answers['GET identity/customer/session'] = {
      status: 401,
      body: { code: 'access.unauthenticated' },
    };
    renderLive();
    expect(await screen.findByRole('button', { name: 'Log in and continue' })).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it("pays on Stripe's hosted page through orders/checkout with the saved address and the quote", async () => {
    answers['POST orders/checkout'] = {
      status: 200,
      body: { orderId: ORDER, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' },
    };
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
    renderLive();
    // The real address book's default is picked, and delivery is priced for it.
    await screen.findByText('12 Example Street, Kedron QLD 4031', { exact: false });
    fireEvent.click(screen.getByRole('radio', { name: /^Stripe/ }));
    for (const radio of await screen.findAllByRole('radio', { name: /^Instant/ }))
      fireEvent.click(radio);
    await waitFor(() =>
      expect(payButtons().every((b) => b.getAttribute('aria-disabled') !== 'true')).toBe(true),
    );
    fireEvent.click(payButtons()[0]!);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1'),
    );
    expect(posted('orders/delivery-quotes')[0]!.body).toEqual({ addressId: ADDRESS });
    expect(posted('orders/checkout')[0]!.body).toEqual({
      addressId: ADDRESS,
      deliveryMethods: { [SELLER]: { method: 'instant', quoteId: QUOTE } },
    });
    expect(payOrder).not.toHaveBeenCalled();
  });

  it('saves a new address to the address book before pricing delivery to it', async () => {
    answers['GET customers/me/addresses'] = { status: 200, body: { addresses: [] } };
    answers['POST customers/me/addresses'] = { status: 201, body: address(NEW_ADDRESS, true) };
    renderLive();
    const save = await screen.findByRole('button', { name: 'Save and use this address' });
    // The separate fields only: the place search is the sample's.
    expect(screen.queryByRole('button', { name: /search/i })).toBeNull();
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Jo Rahman' } });
    fireEvent.change(screen.getByLabelText(/^Mobile/), { target: { value: '0400000000' } });
    fireEvent.change(screen.getByLabelText('Street address and unit'), {
      target: { value: '12 Example Street' },
    });
    fireEvent.change(screen.getByLabelText('Suburb'), { target: { value: 'Kedron' } });
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '4031' } });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    // No quote for an address the API does not hold.
    expect(posted('orders/delivery-quotes')).toHaveLength(0);
    answers['GET customers/me/addresses'] = {
      status: 200,
      body: { addresses: [address(NEW_ADDRESS, true)] },
    };
    fireEvent.click(save);
    await waitFor(() => expect(posted('orders/delivery-quotes')).toHaveLength(1));
    expect(posted('customers/me/addresses')[0]!.body).toMatchObject({
      recipientFirstName: 'Jo',
      recipientLastName: 'Rahman',
      line1: '12 Example Street',
      suburb: 'Kedron',
      postcode: '4031',
    });
    expect(posted('orders/delivery-quotes')[0]!.body).toEqual({ addressId: NEW_ADDRESS });
  });

  /** Stripe.js as the Card tile uses it; `next` is what the bank check answers. */
  function stubStripe(next: Record<string, unknown>) {
    const handled = vi.fn((options: { clientSecret: string }) =>
      Promise.resolve(options.clientSecret ? next : {}),
    );
    vi.stubGlobal('Stripe', () => ({
      elements: () => ({
        create: () => ({
          mount: vi.fn(),
          destroy: vi.fn(),
          focus: vi.fn(),
          on: (event: string, handler: () => void) => {
            if (event === 'ready') setTimeout(handler, 0);
          },
        }),
        update: vi.fn(),
        submit: () => Promise.resolve({}),
      }),
      createConfirmationToken: () => Promise.resolve({ confirmationToken: { id: 'ctoken_live1' } }),
      handleNextAction: handled,
    }));
    return handled;
  }

  function renderCard() {
    return render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider live initialLiveCart={cart}>
          <main>
            <CheckoutPage
              source={{ ...source, card: { kind: 'stripe', publishableKey: 'pk_test_51Live' } }}
            />
          </main>
        </StoreProvider>
      </NextIntlClientProvider>,
    );
  }

  async function readyToPay() {
    await screen.findByText('12 Example Street, Kedron QLD 4031', { exact: false });
    for (const radio of await screen.findAllByRole('radio', { name: /^Instant/ }))
      fireEvent.click(radio);
    await waitFor(() => expect(screen.queryByText('Loading the secure card fields...')).toBeNull());
    fireEvent.change(screen.getByLabelText('Name on card'), { target: { value: 'Jo Rahman' } });
    await waitFor(() =>
      expect(payButtons().every((b) => b.getAttribute('aria-disabled') !== 'true')).toBe(true),
    );
  }

  it('pays by card after the bank check, once however often Pay is pressed', async () => {
    const handled = stubStripe({ paymentIntent: { status: 'requires_capture' } });
    answers['POST orders/pay'] = {
      status: 200,
      body: { orderId: ORDER, status: 'requires-action', clientSecret: 'pi_1_secret_2' },
    };
    renderCard();
    await readyToPay();
    const pay = payButtons()[0]!;
    fireEvent.click(pay);
    fireEvent.click(pay);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/checkout/confirmation'));
    expect(posted('orders/pay')).toHaveLength(1);
    expect(posted('orders/pay')[0]!.body).toMatchObject({
      addressId: ADDRESS,
      confirmationToken: 'ctoken_live1',
      expectedTotal: { amount: '3490', currency: 'AUD' },
    });
    expect(handled).toHaveBeenCalledWith({ clientSecret: 'pi_1_secret_2' });
  });

  it('is not paid when the bank check fails', async () => {
    stubStripe({ paymentIntent: { status: 'requires_payment_method' } });
    answers['POST orders/pay'] = {
      status: 200,
      body: { orderId: ORDER, status: 'requires-action', clientSecret: 'pi_1_secret_2' },
    };
    renderCard();
    await readyToPay();
    fireEvent.click(payButtons()[0]!);
    expect(await screen.findByText('Your card was declined.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('asks for a new log-in when the session ended during Pay', async () => {
    stubStripe({});
    answers['POST orders/pay'] = { status: 401, body: { code: 'session.invalid' } };
    renderCard();
    await readyToPay();
    fireEvent.click(payButtons()[0]!);
    expect(await screen.findByRole('button', { name: 'Log in and continue' })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
