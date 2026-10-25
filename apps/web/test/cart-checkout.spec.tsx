// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { CartDrawer } from '../src/cart/cart-drawer.tsx';
import { CartPage } from '../src/cart/cart-page.tsx';
import { limitLine, viewCart, type Cart } from '../src/cart/cart.ts';
import { CheckoutPage, inServiceArea, safeRedirect } from '../src/checkout/checkout-page.tsx';
import { Confirmation } from '../src/checkout/payment-result.tsx';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';
import type {
  CartSource,
  DeliveryMethod,
  MethodOption,
  MethodPrice,
  SellerDeliveryOptions,
} from '../src/storefront/types.ts';

const push = vi.fn();
const scrolled = vi.fn();
const replace = vi.fn();
let path = '/';
const { deliveryAreaFor, deliveryOptionsFor, payOrder } = vi.hoisted(() => ({
  deliveryAreaFor: vi.fn<(postcode: string) => Promise<{ kind: string }>>(),
  deliveryOptionsFor: vi.fn<(request: unknown) => Promise<Record<string, unknown>>>(),
  payOrder: vi.fn<(request: unknown) => Promise<Record<string, unknown>>>(),
}));
vi.mock('../src/checkout/actions.ts', () => ({ deliveryAreaFor, deliveryOptionsFor, payOrder }));
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push, replace }),
}));

beforeEach(() => {
  path = '/';
  push.mockReset();
  replace.mockReset();
  deliveryAreaFor.mockReset();
  deliveryOptionsFor.mockReset();
  payOrder.mockReset();
  payOrder.mockImplementation((request) =>
    Promise.resolve(
      (request as { method: string }).method === 'stripe'
        ? { kind: 'redirect', url: '/checkout/payment' }
        : { kind: 'paid', reference: 'MP-1' },
    ),
  );
  // The sample options: every method open for Kedron, no same-day for Paddington (past cut-off).
  deliveryOptionsFor.mockImplementation((request) => sampleAnswer(request));
  Element.prototype.scrollIntoView = scrolled;
  scrolled.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const aud = (amount: number) => ({ amount, currency: 'AUD' });

/** The sample delivery options for the sellers a request names. */
async function sampleOf(
  sellerIds: readonly string[],
): Promise<Record<string, SellerDeliveryOptions>> {
  const { sampleDeliveryOptions } = await import('../src/storefront/sample-delivery-options.ts');
  return sampleDeliveryOptions(sellerIds);
}

async function sampleAnswer(request: unknown): Promise<Record<string, unknown>> {
  return { kind: 'ok', sellers: await sampleOf((request as { sellerIds: string[] }).sellerIds) };
}

/** One seller's options with a method's price changed. */
function priced(
  options: SellerDeliveryOptions,
  method: DeliveryMethod,
  change: Partial<MethodOption>,
): SellerDeliveryOptions {
  return {
    ...options,
    methods: options.methods.map((m) => (m.method === method ? { ...m, ...change } : m)),
  };
}

const quotedPrice = (id: string, total: number): MethodPrice => ({
  state: 'quoted',
  quoteId: id,
  total: aud(total),
  tax: aud(Math.round(total / 11)),
  etaMinutes: 45,
  validUntil: '2099-01-01T00:00:00Z',
});

/** Picks Instant (A$12.90 each in the sample) for every seller that offers it. */
async function pickInstant() {
  for (const radio of await screen.findAllByRole('radio', { name: /^Instant/ }))
    if (radio.getAttribute('aria-disabled') !== 'true') fireEvent.click(radio);
}

/** A line as the store holds it, priced from the sample source. */
function line(id: string, quantity: number): Cart {
  const item = SAMPLE_CART_SOURCE.items[id]!;
  return { [id]: { quantity, unitPrice: item.price, limit: 12 } };
}

/** Signs the sample customer in before the page under test renders. */
function SignIn() {
  const { setCustomer } = useStore();
  useLayoutEffect(() => setCustomer(SAMPLE_CHECKOUT.customer), [setCustomer]);
  return null;
}

function renderWith(node: ReactNode, cart: Cart = {}, signedIn = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider cartSource={SAMPLE_CART_SOURCE} initialCart={cart}>
        {signedIn ? <SignIn /> : null}
        {node}
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

// Kedron (A$40 minimum) below its minimum; Paddington (no minimum) fine.
const SHORT: Cart = { ...line('whole-chicken', 1), ...line('sourdough', 2) };
const MET: Cart = { ...line('brisket', 1), ...line('sourdough', 1) };

describe('cart view', () => {
  it('lowers a line to the stock left, or removes it', () => {
    expect(limitLine(MET, 'brisket', 0)).not.toHaveProperty('brisket');
    expect(limitLine({ ...line('brisket', 3) }, 'brisket', 2).brisket).toMatchObject({
      quantity: 2,
      limit: 2,
    });
    expect(limitLine({ ...line('brisket', 1) }, 'brisket', 5).brisket).toMatchObject({
      quantity: 1,
      limit: 5,
    });
    expect(limitLine(MET, 'nothing', 1)).toBe(MET);
  });

  it('groups lines by seller with each seller shortfall; delivery is priced at checkout', () => {
    const view = viewCart(SHORT, SAMPLE_CART_SOURCE)!;
    expect(view.groups.map((g) => g.seller.id)).toEqual(['kedron', 'paddington']);
    expect(view.groups[0]!.shortfall).toEqual(aud(4000 - 2290));
    expect(view.groups[1]!.shortfall).toEqual(aud(0));
    expect(view.items).toEqual(aud(2290 + 2 * 850));
    expect(view.delivery).toEqual(aud(0));
    expect(view.deliveryPending).toBe(true);
    expect(view.total).toEqual(aud(2290 + 1700));
    expect(view.blocked.map((g) => g.seller.id)).toEqual(['kedron']);
    expect(view.count).toBe(3);
  });

  it('takes the items tax from the source preview and the delivery tax from the quote', () => {
    const view = viewCart(MET, SAMPLE_CART_SOURCE)!;
    expect(view.includedTax).toEqual(aud(Math.round(5540 / 11)));
    const other = viewCart(MET, {
      ...SAMPLE_CART_SOURCE,
      tax: { share: { numerator: 3, denominator: 23 } },
    })!;
    expect(other.includedTax).toEqual(aud(Math.round((5540 * 3) / 23)));
    const chosen = viewCart(MET, SAMPLE_CART_SOURCE, null, {
      kedron: { method: 'instant', quoteId: 'q', total: aud(1290), tax: aud(117), window: null },
      paddington: { method: 'pickup', quoteId: null, total: aud(0), tax: aud(0), window: null },
    })!;
    expect(chosen.deliveryPending).toBe(false);
    expect(chosen.total).toEqual(aud(5540 + 1290));
    expect(chosen.includedTax).toEqual(aud(Math.round(5540 / 11) + 117));
  });

  it('works in another Market currency', () => {
    const nzd = (amount: number) => ({ amount, currency: 'NZD' });
    const source: CartSource = {
      items: { a: { name: 'Feijoa jam', sellerId: 's', category: 'pantry', price: nzd(900) } },
      sellers: { s: { id: 's', name: 'Seller' } },
      tax: { share: { numerator: 3, denominator: 23 } },
      sampleDiscounts: {},
    };
    const view = viewCart({ a: { quantity: 2, unitPrice: nzd(900), limit: 12 } }, source)!;
    expect(view.total).toEqual(nzd(1800));
    expect(view.blocked).toEqual([]);
  });

  it('is null for an empty cart or lines the source does not know', () => {
    expect(viewCart({}, SAMPLE_CART_SOURCE)).toBeNull();
    expect(
      viewCart({ nope: { quantity: 1, unitPrice: aud(1), limit: 1 } }, SAMPLE_CART_SOURCE),
    ).toBeNull();
  });

  it('checks a postcode against the service area', () => {
    const area = SAMPLE_CHECKOUT.serviceArea;
    expect(inServiceArea(area, '4031')).toBe(true);
    expect(inServiceArea(area, '4210')).toBe(false);
    expect(inServiceArea(area, '400')).toBe(false);
    expect(inServiceArea(area, '40a1')).toBe(false);
  });
});

describe('cart drawer', () => {
  it('opens from the header cart button, blocks checkout below a minimum and closes on Esc', () => {
    renderWith(
      <>
        <Header delivery={{ label: 'Brisbane 4000' }} />
        <CartDrawer />
      </>,
      SHORT,
    );
    const pill = screen.getByRole('button', { name: /^Cart, 3 items/ });
    fireEvent.click(pill);
    const drawer = screen.getByRole('dialog', { name: /Cart/ });
    expect(within(drawer).getByText('Kedron Halal Butchers')).toBeTruthy();
    expect(within(drawer).getByText('Add A$17.10 more for the A$40.00 minimum.')).toBeTruthy();
    const checkout = within(drawer).getByRole('button', { name: 'Checkout' });
    expect(checkout.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(checkout);
    expect(push).toHaveBeenCalledWith('/cart#seller-kedron');
    fireEvent.click(pill);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pill.getAttribute('aria-expanded')).toBe('false');
  });

  it('does nothing on the cart page itself', () => {
    path = '/cart';
    renderWith(<Header delivery={{ label: 'Brisbane 4000' }} />, SHORT);
    const pill = screen.getByRole('button', { name: /^Cart, 3 items/ });
    expect(pill.getAttribute('aria-haspopup')).toBeNull();
    expect(pill.getAttribute('aria-current')).toBe('page');
  });
});

describe('cart page', () => {
  it('shows each seller, the minimum progress and the blocked checkout', () => {
    renderWith(<CartPage />, SHORT);
    expect(screen.getByRole('heading', { level: 1, name: 'Cart' })).toBeTruthy();
    expect(screen.getByText('3 items from 2 sellers')).toBeTruthy();
    const kedron = screen.getByRole('region', { name: 'Kedron Halal Butchers' });
    expect(
      within(kedron).getByText("Add A$17.10 more to reach this seller's A$40.00 minimum order."),
    ).toBeTruthy();
    expect(within(kedron).getByText('Only 3 left')).toBeTruthy();
    expect(screen.getByText('Minimum order not reached').closest('[role=status]')).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: 'Checkout' })) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
    }
    expect(push).not.toHaveBeenCalled();
    expect(scrolled).toHaveBeenCalled();
  });

  it('goes to checkout once every seller meets its minimum, with the GST line', () => {
    renderWith(<CartPage />, MET);
    expect(screen.queryByText('Minimum order not reached')).toBeNull();
    expect(screen.getByText('Includes GST')).toBeTruthy();
    expect(screen.getByText('A$5.04')).toBeTruthy();
    expect(screen.getByText('Minimum order of A$40.00 reached.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Checkout' })[0]!);
    expect(push).toHaveBeenCalledWith('/checkout');
  });

  it('notes a changed price until dismissed, and removes a line', () => {
    renderWith(<CartPage />, MET);
    expect(screen.getByText(/is now A\$46\.90/).textContent).toContain(
      'Beef brisket, 1 kg is now A$46.90 (it was A$48.90 when you added it).',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/is now A\$46\.90/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Beef brisket, 1 kg' }));
    expect(screen.queryByRole('region', { name: 'Kedron Halal Butchers' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sourdough loaf, 800 g' }));
    expect(screen.getByRole('heading', { name: 'Your cart is empty' })).toBeTruthy();
  });
});

/** A stand-in for Stripe.js: records what the page asks of it. */
function fakeStripe({
  load = 'ready',
  submit = {},
}: { load?: 'ready' | 'loaderror'; submit?: Record<string, unknown> } = {}) {
  const elements: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const focused = vi.fn();
  vi.stubGlobal('Stripe', () => ({
    elements: (options: Record<string, unknown>) => {
      elements.push(options);
      return {
        create: () => ({
          mount: vi.fn(),
          destroy: vi.fn(),
          focus: focused,
          on: (event: string, handler: () => void) => {
            if (event === load) setTimeout(handler, 0);
          },
        }),
        update: (options: Record<string, unknown>) => updates.push(options),
        submit: () => Promise.resolve(submit),
      };
    },
    createConfirmationToken: () => Promise.resolve({ confirmationToken: { id: 'ctoken_test1' } }),
  }));
  return { elements, updates, focused };
}

const STRIPE_CHECKOUT = {
  ...SAMPLE_CHECKOUT,
  card: { kind: 'stripe', publishableKey: 'pk_test_51Sample' },
} as const;

describe('checkout', () => {
  /** The Pay buttons (the right column's and the one ending the form on phone and tablet). */
  const payButtons = () => screen.getAllByRole('button', { name: /^Pay A\$/ });
  const payOff = () => payButtons().every((b) => b.getAttribute('aria-disabled') === 'true');

  it('asks a guest to log in or create an account, keeping the cart', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET);
    const progress = screen.getByRole('list', { name: 'Checkout progress' });
    expect(
      within(progress)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Cart (done)', '2Log in', '3Delivery and payment', '4Confirmation']);
    expect(within(progress).getByText('Log in').closest('li')!.getAttribute('aria-current')).toBe(
      'step',
    );
    expect(screen.getByRole('button', { name: 'Log in' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByLabelText('Full name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create account and continue' }));
    // One page now: the address section takes the focus; Log in leaves the progress bar.
    expect(document.activeElement?.textContent).toBe('Delivery address');
    expect(screen.getByRole('heading', { name: 'Delivery method' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Payment method' })).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Checkout progress' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Cart (done)', '2Delivery and payment', '3Confirmation']);
  });

  it('holds Pay until each seller has a delivery method, then pays with the stored quote', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await screen.findAllByRole('radio', { name: /^Instant/ });
    expect(deliveryOptionsFor).toHaveBeenCalledWith({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron', 'paddington'],
    });
    // Nothing is chosen for the buyer: Pay says what is missing and the total is items only.
    expect(payOff()).toBe(true);
    expect(
      screen.getAllByText('Choose a delivery method for each seller above to pay.'),
    ).toHaveLength(1);
    const kedron = screen.getByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    for (const radio of within(kedron).getAllByRole('radio'))
      expect(radio).toHaveProperty('checked', false);
    fireEvent.click(within(kedron).getByRole('radio', { name: /^Instant/ }));
    expect(payOff()).toBe(true);
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    expect(payButtons()[0]!.textContent).toBe('Pay A$81.20');
    fireEvent.click(payButtons()[0]!);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/checkout/confirmation'));
    // The order carries the method and the stored quote's id, and the price only to compare.
    expect(payOrder).toHaveBeenCalledWith({
      method: 'card',
      confirmationToken: null,
      address: { kind: 'saved', id: 'home' },
      lines: { brisket: 1, sourdough: 1 },
      delivery: {
        kedron: {
          method: 'instant',
          quoteId: 'sample-kedron-instant',
          window: null,
          total: aud(1290),
        },
        paddington: {
          method: 'instant',
          quoteId: 'sample-paddington-instant',
          window: null,
          total: aud(1290),
        },
      },
      discountCode: null,
      total: aud(8120),
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it('pays on Stripe from the Stripe tile, and says the card is the default', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    const card = screen.getByRole('radio', { name: /^Card/ });
    expect(card).toHaveProperty('checked', true);
    expect(screen.getByText(/^Sample: card fields are not connected yet\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Stripe/ }));
    expect(screen.getByText('Pay securely on Stripe')).toBeTruthy();
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    const pay = payButtons()[0]!;
    expect(pay.textContent).toBe('Pay A$81.20 with Stripe');
    fireEvent.click(pay);
    expect(pay.textContent).toBe('Taking you to Stripe...');
    expect(pay.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/checkout/payment'));
    expect(payOrder).toHaveBeenCalledWith(expect.objectContaining({ method: 'stripe' }));
  });

  it("takes the card in Stripe's fields and sends only the confirmation token", async () => {
    const elementsOptions: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const tokenParams: Record<string, unknown>[] = [];
    const mounted = vi.fn();
    vi.stubGlobal('Stripe', (key: string) => {
      expect(key).toBe('pk_test_51Sample');
      return {
        elements: (options: Record<string, unknown>) => {
          elementsOptions.push(options);
          return {
            create: () => ({
              mount: mounted,
              destroy: vi.fn(),
              on: (event: string, handler: () => void) => {
                if (event === 'ready') setTimeout(handler, 0);
              },
            }),
            update: (options: Record<string, unknown>) => updates.push(options),
            submit: () => Promise.resolve({}),
          };
        },
        createConfirmationToken: (options: { params: Record<string, unknown> }) => {
          tokenParams.push(options.params);
          return Promise.resolve({ confirmationToken: { id: 'ctoken_test1' } });
        },
      };
    });
    renderWith(
      <CheckoutPage
        source={{
          ...SAMPLE_CHECKOUT,
          card: { kind: 'stripe', publishableKey: 'pk_test_51Sample' },
        }}
      />,
      MET,
      true,
    );
    expect(screen.getByText('Loading the secure card fields...')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Loading the secure card fields...')).toBeNull());
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(elementsOptions[0]).toMatchObject({
      mode: 'payment',
      amount: 5540,
      currency: 'aud',
      captureMethod: 'manual',
      paymentMethodTypes: ['card'],
    });
    // The delivery prices change the total: the fields follow.
    await pickInstant();
    await waitFor(() => expect(updates.at(-1)).toEqual({ amount: 8120, currency: 'aud' }));
    // The name on the card is asked for first.
    fireEvent.click(payButtons()[0]!);
    const name = screen.getByLabelText('Name on card');
    expect(screen.getByText('Enter the name on the card.')).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(payOrder).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'Alex Nguyen' } });
    fireEvent.click(payButtons()[0]!);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/checkout/confirmation'));
    expect(tokenParams).toEqual([
      { payment_method_data: { billing_details: { name: 'Alex Nguyen' } } },
    ]);
    expect(payOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'card',
        confirmationToken: 'ctoken_test1',
        total: aud(8120),
      }),
    );
  });

  it("mounts Stripe's fields with the total of the moment after a switch back to Card", async () => {
    const stripe = fakeStripe();
    renderWith(<CheckoutPage source={STRIPE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$81.20'));
    fireEvent.click(screen.getByRole('radio', { name: /^Stripe/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Card/ }));
    await waitFor(() => expect(stripe.elements).toHaveLength(2));
    expect(stripe.elements[1]).toMatchObject({ amount: 8120, currency: 'aud' });
  });

  it('holds Pay while the card fields cannot load, and loads them again on Try again', async () => {
    const stripe = fakeStripe({ load: 'loaderror' });
    renderWith(<CheckoutPage source={STRIPE_CHECKOUT} />, MET, true);
    await pickInstant();
    expect(
      await screen.findByText('The card fields did not load. Try again, or pay with Stripe.'),
    ).toBeTruthy();
    expect(payOff()).toBe(true);
    expect(screen.getByText('Wait for the card fields above, or pay with Stripe.')).toBeTruthy();
    fireEvent.click(payButtons()[0]!);
    expect(payOrder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(stripe.elements).toHaveLength(2));
    // Stripe's page still works meanwhile.
    fireEvent.click(screen.getByRole('radio', { name: /^Stripe/ }));
    await waitFor(() => expect(payOff()).toBe(false));
  });

  it("leaves Stripe's own errors in its fields and puts the focus there", async () => {
    const stripe = fakeStripe({ submit: { error: { type: 'validation_error' } } });
    renderWith(<CheckoutPage source={STRIPE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    fireEvent.change(screen.getByLabelText('Name on card'), { target: { value: 'Alex Nguyen' } });
    fireEvent.click(payButtons()[0]!);
    await waitFor(() => expect(stripe.focused).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(payButtons()[0]!.textContent).toBe('Pay A$81.20');
    expect(payOrder).not.toHaveBeenCalled();
  });

  it('sends one Pay however often it is pressed, and locks the order while it waits', async () => {
    let answer: (value: Record<string, unknown>) => void = () => {};
    payOrder.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    const [form, side] = payButtons();
    fireEvent.click(form!);
    fireEvent.click(form!);
    fireEvent.click(side!);
    expect(payOrder).toHaveBeenCalledTimes(1);
    expect(form!.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Paying...', { selector: '.sr-only' })).toBeTruthy();
    expect(document.getElementById('checkout-address')!.closest('[inert]')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Payment method' }).hasAttribute('inert')).toBe(
      true,
    );
    act(() => answer({ kind: 'failed' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'We could not take the payment. Nothing was charged. Try again, or pay with Stripe.',
    );
    expect(document.getElementById('checkout-address')!.closest('[inert]')).toBeNull();
  });

  it('says the payment failed when Pay gets no answer', async () => {
    payOrder.mockRejectedValueOnce(new Error('network'));
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    fireEvent.click(payButtons()[0]!);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'We could not take the payment.',
    );
    expect(payButtons()[0]!.textContent).toBe('Pay A$81.20');
  });

  it('drops a method the seller no longer offers at Pay, and asks the buyer to choose again', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$81.20'));
    const options = await sampleOf(['kedron', 'paddington']);
    payOrder.mockResolvedValueOnce({
      kind: 'price-changed',
      changes: [{ sellerId: 'kedron', was: aud(1290), now: aud(0) }],
      options: {
        kedron: priced(options.kedron!, 'instant', {
          available: false,
          reason: 'seller-unsupported',
          price: null,
        }),
        paddington: options.paddington!,
      },
    });
    fireEvent.click(payButtons()[0]!);
    await screen.findByRole('alert');
    const kedron = screen.getByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    const instant = within(kedron).getByRole('radio', { name: /^Instant/ });
    expect(instant.getAttribute('aria-disabled')).toBe('true');
    expect(within(kedron).getByText("This store doesn't support instant delivery")).toBeTruthy();
    expect(payOff()).toBe(true);
  });

  it('follows only Stripe or a page of this site', () => {
    const origin = 'http://localhost:3000';
    expect(safeRedirect('/checkout/payment?x=1', origin)).toEqual({
      own: true,
      href: '/checkout/payment?x=1',
    });
    expect(safeRedirect('https://checkout.stripe.com/c/pay/cs_test_1', origin)).toEqual({
      own: false,
      href: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    for (const url of [
      '//evil.example/x',
      '/\\evil.example/x',
      '/\t/evil.example',
      'https://evil.example/',
      'https://checkout.stripe.com.evil.example/',
      'javascript:alert(1)',
      `${origin}/checkout`,
    ])
      expect(safeRedirect(url, origin)).toBeNull();
  });

  it('shows a changed delivery price with the new total, charging nothing', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$81.20'));
    const options = await sampleOf(['kedron', 'paddington']);
    payOrder.mockResolvedValueOnce({
      kind: 'price-changed',
      changes: [{ sellerId: 'kedron', was: aud(1290), now: aud(1490) }],
      options: {
        kedron: priced(options.kedron!, 'instant', { price: quotedPrice('q-new', 1490) }),
        paddington: options.paddington!,
      },
    });
    fireEvent.click(payButtons()[0]!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'A delivery price changed. Kedron Halal Butchers, Instant: A$12.90 → A$14.90. Your delivery choices are kept and your new total is shown. Nothing has been charged.',
    );
    expect(payButtons()[0]!.textContent).toBe('Pay A$83.20');
    expect(document.activeElement?.textContent).toBe('Payment method');
    expect(push).not.toHaveBeenCalled();
    // The next Pay sends the new quote's id.
    fireEvent.click(payButtons()[0]!);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/checkout/confirmation'));
    const sent = payOrder.mock.calls.at(-1)![0] as {
      delivery: Record<string, { quoteId: string; total: unknown }>;
    };
    expect(sent.delivery.kedron).toMatchObject({ quoteId: 'q-new', total: aud(1490) });
  });

  it('lowers a line whose stock ran out and holds Pay until the cart is reviewed', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    payOrder.mockResolvedValueOnce({
      kind: 'stock-changed',
      changes: [{ itemId: 'sourdough', was: 1, now: 0 }],
    });
    fireEvent.click(payButtons()[0]!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sourdough loaf, 800 g is sold out and was removed.');
    expect(within(alert).getByRole('link', { name: 'Review cart' }).getAttribute('href')).toBe(
      '/cart',
    );
    expect(payOff()).toBe(true);
    // The quotes are asked again for the sellers left; the notice says why Pay is held.
    await waitFor(() =>
      expect(payButtons().map((b) => b.getAttribute('aria-describedby'))).toEqual([
        'checkout-pay-notice',
        'checkout-pay-notice',
      ]),
    );
    expect(document.getElementById('checkout-pay-notice')?.textContent).toContain('Stock changed.');
    expect(screen.queryByRole('heading', { name: 'Paddington Bakehouse' })).toBeNull();
    expect(payOff()).toBe(true);
  });

  it('tells the cart what stock Pay lowered when checkout sends the buyer back', async () => {
    renderWith(
      <>
        <CheckoutPage source={SAMPLE_CHECKOUT} />
        <CartPage />
      </>,
      MET,
      true,
    );
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    payOrder.mockResolvedValueOnce({
      kind: 'stock-changed',
      changes: [
        { itemId: 'brisket', was: 1, now: 0 },
        { itemId: 'sourdough', was: 1, now: 0 },
      ],
    });
    fireEvent.click(payButtons()[0]!);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/cart'));
    const note = screen.getByText(/^Stock changed\./).closest('.cnote')!;
    expect(note.textContent).toContain(
      'Beef brisket, 1 kg is sold out and was removed. Sourdough loaf, 800 g is sold out and was removed.',
    );
    fireEvent.click(within(note as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/^Stock changed\./)).toBeNull();
  });

  it('says a declined card or a failure charged nothing, and Pay can be pressed again', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    payOrder.mockResolvedValueOnce({ kind: 'declined' });
    fireEvent.click(payButtons()[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Your card was declined. Nothing was charged. Check the details, use another card or pay with Stripe.',
    );
    expect(payOff()).toBe(false);
    // Choosing Stripe instead clears the card's notice.
    fireEvent.click(screen.getByRole('radio', { name: /^Stripe/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    payOrder.mockResolvedValueOnce({ kind: 'redirect', url: 'https://evil.example/pay' });
    fireEvent.click(payButtons()[0]!);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'We could not take the payment. Nothing was charged.',
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the four methods with their prices, and why a method is off', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    const kedron = await screen.findByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    const names = within(kedron)
      .getAllByRole('radio')
      .map((r) => r.closest('label')!.textContent);
    expect(names).toEqual([
      'PickupCollect it from the seller, postcode 4031Free',
      'InstantAbout 45 minutes once the seller has it readyA$12.90incl. GST',
      'Same dayDelivered todayA$9.90incl. GST',
      'ScheduledDelivered in the day and window you chooseA$7.90incl. GST',
    ]);
    // Same day closed at the cut-off for Paddington: disabled, with the reason.
    const paddington = screen.getByRole('radiogroup', {
      name: 'Delivery method for Paddington Bakehouse',
    });
    const sameDay = within(paddington).getByRole('radio', { name: /^Same day/ });
    expect(sameDay.getAttribute('aria-disabled')).toBe('true');
    expect(
      within(paddington).getByText('Same-day delivery closes at 12:00 pm (Brisbane time)'),
    ).toBeTruthy();
    expect(
      within(paddington)
        .getByRole('radio', { name: /^Instant/ })
        .getAttribute('aria-disabled'),
    ).toBe(null);
    // The GST is shown inside the price and in the summary, apart from it.
    fireEvent.click(within(kedron).getByRole('radio', { name: /^Instant/ }));
    fireEvent.click(within(paddington).getByRole('radio', { name: /^Pickup/ }));
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$68.30'));
    expect(screen.getAllByText('Includes GST').length).toBeGreaterThan(0);
  });

  it('shows the reasons a store cannot offer a method, and what no courier can carry', async () => {
    deliveryOptionsFor.mockResolvedValueOnce({
      kind: 'ok',
      sellers: {
        kedron: (await sampleOf(['sunnybank']))['sunnybank']!,
        paddington: (await sampleOf(['inala']))['inala']!,
      },
    });
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    const kedron = await screen.findByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    expect(within(kedron).getByText("This store doesn't support instant delivery")).toBeTruthy();
    const paddington = screen.getByRole('radiogroup', {
      name: 'Delivery method for Paddington Bakehouse',
    });
    expect(within(paddington).getByText("Pickup isn't offered by this store")).toBeTruthy();
    expect(
      within(paddington)
        .getByRole('radio', { name: /^Pickup/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('disables a method no courier can carry or price now', async () => {
    const options = await sampleOf(['kedron', 'paddington']);
    deliveryOptionsFor.mockResolvedValueOnce({
      kind: 'ok',
      sellers: {
        kedron: priced(
          priced(options.kedron!, 'scheduled', { price: { state: 'no-fleet' } }),
          'instant',
          {
            price: { state: 'failed' },
          },
        ),
        paddington: options.paddington!,
      },
    });
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    const kedron = await screen.findByRole('radiogroup', {
      name: 'Delivery method for Kedron Halal Butchers',
    });
    expect(within(kedron).getByText('No courier can deliver this to your address')).toBeTruthy();
    expect(within(kedron).getByText('Price not available right now')).toBeTruthy();
    expect(
      within(kedron)
        .getByRole('radio', { name: /^Scheduled/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      within(kedron)
        .getByRole('radio', { name: /^Instant/ })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('holds Pay while prices load, and offers Try again when they could not be asked', async () => {
    let answer: (value: Record<string, unknown>) => void = () => {};
    deliveryOptionsFor.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    expect(payOff()).toBe(true);
    expect(screen.getAllByText('Getting delivery prices...')).toHaveLength(2);
    answer({ kind: 'failed' });
    const failed = (await screen.findAllByRole('alert'))[0]!;
    expect(failed.textContent).toContain('We could not get a delivery price.');
    expect(payOff()).toBe(true);
    expect(screen.getAllByText('Fix the delivery problem above to pay.').length).toBe(1);
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    expect(deliveryOptionsFor).toHaveBeenLastCalledWith({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron', 'paddington'],
    });
  });

  it('drops a late answer for an address the buyer has left', async () => {
    const answers: Record<string, (value: Record<string, unknown>) => void> = {};
    deliveryOptionsFor.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          answers[(request as { address: { id: string } }).address.id] = resolve;
        }),
    );
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /^Sam Nguyen/ }));
    await waitFor(() => expect(answers.work).toBeDefined());
    const options = await sampleOf(['kedron', 'paddington']);
    const cheaper = {
      kedron: priced(options.kedron!, 'instant', { price: quotedPrice('q-work', 990) }),
      paddington: options.paddington!,
    };
    act(() => answers.work!({ kind: 'ok', sellers: cheaper }));
    await screen.findByRole('radio', { name: /^Instant.*A\$9\.90/ });
    // Home's answer arrives after Work's: it is not shown.
    act(() => answers.home!({ kind: 'ok', sellers: options }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Only Paddington's Instant is still A$12.90; Kedron's is Work's A$9.90.
    expect(screen.getAllByRole('radio', { name: /^Instant.*A\$12\.90/ })).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /^Instant.*A\$9\.90/ })).toBeTruthy();
  });

  it('updates the total to a new price, and keeps the wished method through a failure', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await pickInstant();
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$81.20'));
    // Another address prices Instant differently; the total follows.
    const options = await sampleOf(['kedron', 'paddington']);
    deliveryOptionsFor.mockResolvedValueOnce({
      kind: 'ok',
      sellers: {
        kedron: priced(options.kedron!, 'instant', { price: quotedPrice('q-work', 1590) }),
        paddington: options.paddington!,
      },
    });
    fireEvent.click(screen.getByRole('radio', { name: /^Sam Nguyen/ }));
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$84.20'));
    // A failed answer holds Pay; Try again brings the choice back.
    deliveryOptionsFor.mockResolvedValueOnce({ kind: 'failed' });
    fireEvent.click(screen.getByRole('radio', { name: /^Alex Nguyen/ }));
    const failed = (await screen.findAllByRole('alert'))[0]!;
    expect(screen.queryByRole('radio', { name: /^Instant/ })).toBeNull();
    expect(payOff()).toBe(true);
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    const instant = await screen.findAllByRole('radio', { name: /^Instant.*A\$12\.90/ });
    expect(instant[0]).toHaveProperty('checked', true);
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$81.20'));
  });

  it('shows no methods until there is an address to price', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    expect(
      screen.getAllByText('Choose a saved address to see delivery methods and prices.'),
    ).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /^Instant/ })).toBeNull();
    // Pay says why it is off, and a press takes the buyer to the first missing field.
    const pay = payButtons()[0]!;
    const reason = document.getElementById(pay.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toBe('Complete the new address above to pay.');
    fireEvent.click(pay);
    expect(push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Address' }));
  });

  it('holds Pay offline, and asks failed prices again when the connection is back', async () => {
    deliveryOptionsFor.mockResolvedValueOnce({ kind: 'failed' });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await screen.findAllByRole('alert');
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(
      screen.getAllByText('You are offline. Pay works again when your connection is back.'),
    ).toHaveLength(2);
    expect(payOff()).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await pickInstant();
    await waitFor(() => expect(payOff()).toBe(false));
    expect(deliveryOptionsFor).toHaveBeenLastCalledWith({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron', 'paddington'],
    });
  });

  it('finds a new address by postcode, suburb and street with the keyboard', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    expect(payOff()).toBe(true);
    expect(screen.getByText('Complete the new address above to pay.')).toBeTruthy();
    const search = screen.getByRole('combobox', { name: 'Address' });
    fireEvent.change(search, { target: { value: '403' } });
    const options = () =>
      screen.getAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim());
    expect(options().slice(0, 2)).toEqual([
      'Kedron QLD 4031Suburb: then choose the street',
      'Chermside QLD 4032Suburb: then choose the street',
    ]);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('Kedron QLD 4031')).toBeTruthy();
    expect(options()).toHaveLength(3);
    fireEvent.change(search, { target: { value: 'test' } });
    expect(options()).toEqual(['48 Test Avenue, Kedron QLD 4031']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByText('We deliver here')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Unit or apartment (optional)'));
    fireEvent.change(screen.getByLabelText('Unit or apartment (optional)'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Alex Nguyen' } });
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '0400 000 000' } });
    await waitFor(() =>
      expect(deliveryOptionsFor).toHaveBeenLastCalledWith({
        address: { kind: 'new', postcode: '4031' },
        sellerIds: ['kedron', 'paddington'],
      }),
    );
    // Change goes back to the search, with the focus in it.
    fireEvent.click(screen.getByRole('button', { name: 'Change address' }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Address' }));
  });

  it('closes the list on Escape and on leaving the field, and clears on a second Escape', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    const search = screen.getByRole('combobox', { name: 'Address' });
    fireEvent.change(search, { target: { value: '403' } });
    expect(search.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(search).toHaveProperty('value', '403');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveProperty('value', '');
    fireEvent.change(search, { target: { value: 'ked' } });
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    fireEvent.blur(search);
    expect(screen.queryAllByRole('option')).toEqual([]);
    fireEvent.focus(search);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    // A picked suburb's chip says what its button does.
    fireEvent.click(screen.getAllByRole('option')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Change suburb' }));
    await waitFor(() => expect(document.activeElement).toBe(search));
  });

  it('refuses a postcode outside the area and falls back to manual entry', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    const search = screen.getByRole('combobox', { name: 'Address' });
    fireEvent.change(search, { target: { value: '4210' } });
    expect(
      screen.getByText('We do not deliver to 4210 yet. We currently deliver to Greater Brisbane.'),
    ).toBeTruthy();
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(search.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(search, { target: { value: 'Nowhere Street' } });
    expect(document.querySelector('.acst[role=status]')?.textContent).toContain(
      'No addresses found.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enter it manually' }));
    for (const [label, text] of [
      ['Full name', 'Alex Nguyen'],
      ['Mobile number', '0400 000 000'],
      ['Street address and unit', '1 Nowhere Street'],
      ['Suburb', 'Kedron'],
    ] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '4210' } });
    expect(screen.getByRole('alert').textContent).toBe(
      'We do not deliver to 4210 yet. We currently deliver to Greater Brisbane.',
    );
    expect(payOff()).toBe(true);
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '42' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.blur(screen.getByLabelText('Postcode'));
    expect(screen.getByRole('alert').textContent).toContain('We do not deliver to 42 yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Search for the address instead' }));
    expect(screen.getByRole('combobox', { name: 'Address' })).toBeTruthy();
    expect(deliveryAreaFor).not.toHaveBeenCalled();
  });

  it("asks the API whether a new address's postcode is delivered to once API_BASE_URL is set", async () => {
    const answers: Record<string, { kind: string }> = {
      '4031': { kind: 'in' },
      '4210': { kind: 'out' },
      '4000': { kind: 'failed' },
    };
    deliveryAreaFor.mockImplementation((postcode: string) =>
      Promise.resolve(answers[postcode] ?? { kind: 'off' }),
    );
    renderWith(<CheckoutPage source={{ ...SAMPLE_CHECKOUT, areaCheck: 'api' }} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter address manually' }));
    for (const [label, text] of [
      ['Full name', 'Alex Nguyen'],
      ['Mobile number', '0400 000 000'],
      ['Street address and unit', '1 Example Street'],
      ['Suburb', 'Kedron'],
    ] as const)
      fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
    const postcode = screen.getByLabelText('Postcode');

    fireEvent.change(postcode, { target: { value: '4210' } });
    expect(payOff()).toBe(true);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'We do not deliver to 4210 yet. We currently deliver to Greater Brisbane.',
    );

    fireEvent.change(postcode, { target: { value: '4000' } });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'We could not check this postcode just now. Please try again in a moment.',
    );
    expect(payOff()).toBe(true);

    // Short of four characters, nothing is asked.
    fireEvent.change(postcode, { target: { value: '40' } });
    fireEvent.change(postcode, { target: { value: ' 4031 ' } });
    await waitFor(() => expect(deliveryAreaFor).toHaveBeenCalledWith('4031'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(deliveryAreaFor.mock.calls.map(([value]) => value)).toEqual(['4210', '4000', '4031']);
  });

  it('sends a blocked or empty cart back to the cart', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    expect(replace).not.toHaveBeenCalled();
    cleanup();
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, SHORT, true);
    expect(replace).toHaveBeenCalledWith('/cart');
    replace.mockReset();
    cleanup();
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, {}, true);
    expect(replace).toHaveBeenCalledWith('/cart');
  });
});

describe('discount code, save for later and seller note (sample data)', () => {
  it('takes the discount off items only and checks minimums before it', () => {
    const view = viewCart(MET, SAMPLE_CART_SOURCE, { code: 'HALAL10', percentOff: 10 })!;
    expect(view.discount).toEqual(aud(554));
    expect(view.delivery).toEqual(aud(0));
    expect(view.total).toEqual(aud(5540 - 554));
    const source: CartSource = {
      items: { a: { name: 'Lamb', sellerId: 's', category: 'meat', price: aud(1000) } },
      sellers: {
        s: { id: 's', name: 'Seller', minimumOrder: aud(1000) },
      },
      tax: { share: { numerator: 1, denominator: 11 } },
      sampleDiscounts: {},
    };
    const minimum = viewCart({ a: { quantity: 1, unitPrice: aud(1000), limit: 12 } }, source, {
      code: 'X',
      percentOff: 10,
    })!;
    expect(minimum.blocked).toEqual([]);
    expect(minimum.total).toEqual(aud(900));
  });

  it('applies a sample code on the cart page and refuses an unknown one', () => {
    renderWith(<CartPage />, MET);
    fireEvent.click(screen.getByRole('button', { name: 'Have a discount code?' }));
    const input = screen.getByLabelText('Discount code');
    fireEvent.change(input, { target: { value: 'NOPE' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByRole('alert').textContent).toBe('This code is not valid or has expired.');
    fireEvent.change(input, { target: { value: 'halal10' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByText('Discount (HALAL10)')).toBeTruthy();
    expect(screen.getByText('−A$5.54')).toBeTruthy();
    expect(screen.getAllByText('A$49.86').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove discount code HALAL10' }));
    expect(screen.queryByText('Discount (HALAL10)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Have a discount code?' })).toBeTruthy();
  });

  it('saves a line for later outside the totals, then moves it back', () => {
    renderWith(<CartPage />, MET);
    const name = SAMPLE_CART_SOURCE.items.sourdough!.name;
    fireEvent.click(screen.getByRole('button', { name: `Save ${name} for later` }));
    const saved = screen.getByRole('region', { name: 'Saved for later (1)' });
    expect(within(saved).getByText(name)).toBeTruthy();
    expect(within(saved).getByText(/Saved items stay in this browser/)).toBeTruthy();
    expect(screen.getAllByText('A$46.90').length).toBeGreaterThan(0);
    fireEvent.click(within(saved).getByRole('button', { name: `Move ${name} to cart` }));
    expect(screen.queryByRole('region', { name: /Saved for later/ })).toBeNull();
    expect(screen.getAllByText('A$55.40').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: `Save ${name} for later` }));
    fireEvent.click(screen.getByRole('button', { name: `Remove ${name} from saved items` }));
    expect(screen.queryByRole('region', { name: /Saved for later/ })).toBeNull();
  });

  it('keeps a seller note and the delivery choice up to the confirmation', async () => {
    renderWith(
      <>
        <CheckoutPage source={SAMPLE_CHECKOUT} />
        <Confirmation />
      </>,
      MET,
      true,
    );
    fireEvent.click((await screen.findAllByRole('radio', { name: /^Instant.*A\$12\.90/ }))[0]!);
    fireEvent.click(screen.getAllByRole('radio', { name: /^Pickup/ })[1]!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note for this seller' })[0]!);
    const note = screen.getByLabelText(/^Note for Kedron Halal Butchers/);
    expect(note.getAttribute('maxlength')).toBe('200');
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: '<b>Ring the bell</b>' } });
    expect(screen.getByText('20 / 200')).toBeTruthy();
    // The delivery choice is taken when Pay is pressed.
    fireEvent.click(screen.getAllByRole('button', { name: /^Pay A\$/ })[0]!);
    const part = (await screen.findByRole('heading', { name: 'Kedron Halal Butchers' })).closest(
      'article',
    )!;
    expect(within(part).getByText('<b>Ring the bell</b>')).toBeTruthy();
    expect(part.querySelector('p b b')).toBeNull();
    expect(within(part).getByText('Order MP-1-1 · Delivery: Instant')).toBeTruthy();
    const other = screen.getByRole('heading', { name: 'Paddington Bakehouse' }).closest('article')!;
    expect(within(other).getByText('Order MP-1-2 · Delivery: Pickup')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Payment summary' })).toBeTruthy();
  });
});
