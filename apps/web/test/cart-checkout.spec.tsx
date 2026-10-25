// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { CartDrawer } from '../src/cart/cart-drawer.tsx';
import { CartPage } from '../src/cart/cart-page.tsx';
import { viewCart, type Cart } from '../src/cart/cart.ts';
import { CheckoutPage, inServiceArea } from '../src/checkout/checkout-page.tsx';
import { Confirmation, SamplePayment } from '../src/checkout/payment-result.tsx';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';
import type { CartSource } from '../src/storefront/types.ts';

const push = vi.fn();
const scrolled = vi.fn();
const replace = vi.fn();
let path = '/';
const { deliveryAreaFor, deliveryQuotesFor } = vi.hoisted(() => ({
  deliveryAreaFor: vi.fn<(postcode: string) => Promise<{ kind: string }>>(),
  deliveryQuotesFor: vi.fn<(request: unknown) => Promise<Record<string, unknown>>>(),
}));
vi.mock('../src/checkout/actions.ts', () => ({ deliveryAreaFor, deliveryQuotesFor }));
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
  deliveryQuotesFor.mockReset();
  // The sample courier: Express for Kedron, none for Paddington (its cut-off has passed).
  deliveryQuotesFor.mockImplementation((request) =>
    Promise.resolve(
      Object.fromEntries(
        (request as { sellerIds: string[] }).sellerIds.map((id) => [
          id,
          { kind: 'quote', express: id === 'kedron' ? { amount: 1290, currency: 'AUD' } : null },
        ]),
      ),
    ),
  );
  Element.prototype.scrollIntoView = scrolled;
  scrolled.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const aud = (amount: number) => ({ amount, currency: 'AUD' });

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
  it('groups lines by seller with each seller delivery fee and shortfall', () => {
    const view = viewCart(SHORT, SAMPLE_CART_SOURCE)!;
    expect(view.groups.map((g) => g.seller.id)).toEqual(['kedron', 'paddington']);
    expect(view.groups[0]!.shortfall).toEqual(aud(4000 - 2290));
    expect(view.groups[1]!.shortfall).toEqual(aud(0));
    expect(view.items).toEqual(aud(2290 + 2 * 850));
    expect(view.delivery).toEqual(aud(750 + 500));
    expect(view.total).toEqual(aud(2290 + 1700 + 1250));
    expect(view.blocked.map((g) => g.seller.id)).toEqual(['kedron']);
    expect(view.count).toBe(3);
  });

  it('takes the included tax from the source preview, never from a rule of its own', () => {
    const view = viewCart(MET, SAMPLE_CART_SOURCE)!;
    expect(view.includedTax).toEqual(aud(Math.round((4690 + 850 + 750 + 500) / 11)));
    const noDelivery = viewCart(MET, {
      ...SAMPLE_CART_SOURCE,
      tax: { share: { numerator: 3, denominator: 23 }, includesDelivery: false },
    })!;
    expect(noDelivery.includedTax).toEqual(aud(Math.round(((4690 + 850) * 3) / 23)));
  });

  it('works in another Market currency', () => {
    const nzd = (amount: number) => ({ amount, currency: 'NZD' });
    const source: CartSource = {
      items: { a: { name: 'Feijoa jam', sellerId: 's', category: 'pantry', price: nzd(900) } },
      sellers: {
        s: { id: 's', name: 'Seller', deliveryWindow: 'Today', deliveryFee: nzd(400) },
      },
      tax: { share: { numerator: 3, denominator: 23 }, includesDelivery: true },
      sampleDiscounts: {},
    };
    const view = viewCart({ a: { quantity: 2, unitPrice: nzd(900), limit: 12 } }, source)!;
    expect(view.total).toEqual(nzd(2200));
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
    expect(screen.getByText('Prices include GST. Includes A$6.17 GST.')).toBeTruthy();
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

  it('pays for a saved address with each seller on Scheduled delivery by default', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await waitFor(() => expect(payOff()).toBe(false));
    expect(deliveryQuotesFor).toHaveBeenCalledWith({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron', 'paddington'],
    });
    const kedron = screen.getByRole('radiogroup', {
      name: 'Delivery speed for Kedron Halal Butchers',
    });
    expect(within(kedron).getByRole('radio', { name: /Scheduled/ })).toHaveProperty(
      'checked',
      true,
    );
    expect(payButtons()[0]!.textContent).toBe('Pay A$67.90 with Stripe');
    fireEvent.click(payButtons()[0]!);
    expect(push).toHaveBeenCalledWith('/checkout/payment');
  });

  it('adds Express at the courier price, and says why a seller has none', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    const kedron = screen.getByRole('radiogroup', {
      name: 'Delivery speed for Kedron Halal Butchers',
    });
    const express = await within(kedron).findByRole('radio', { name: /Express.*A\$12\.90/ });
    fireEvent.click(express);
    expect(express).toHaveProperty('checked', true);
    // A$67.90 - A$7.50 Scheduled + A$12.90 Express.
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$73.30 with Stripe'));
    const paddington = screen.getByRole('radiogroup', {
      name: 'Delivery speed for Paddington Bakehouse',
    });
    expect(within(paddington).queryAllByRole('radio')).toHaveLength(1);
    expect(
      within(paddington).getByText(
        /Not available\. Express orders for this seller closed at 3\sPM today \(Brisbane time\)\./i,
      ),
    ).toBeTruthy();
  });

  it('holds Pay while quotes load, and offers Try again for a seller without a price', async () => {
    let answer: (value: Record<string, unknown>) => void = () => {};
    deliveryQuotesFor.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    expect(payOff()).toBe(true);
    expect(screen.getAllByText('Getting delivery prices...')).toHaveLength(2);
    answer({ kedron: { kind: 'quote', express: aud(1290) }, paddington: { kind: 'failed' } });
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('We could not get a delivery price.');
    expect(payOff()).toBe(true);
    expect(screen.getAllByText('Fix the delivery problem above to pay.').length).toBe(1);
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(payOff()).toBe(false));
    expect(deliveryQuotesFor).toHaveBeenLastCalledWith({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['paddington'],
    });
  });

  it('says when a seller cannot deliver to the address', async () => {
    deliveryQuotesFor.mockResolvedValueOnce({
      kedron: { kind: 'out-of-range' },
      paddington: { kind: 'quote', express: null },
    });
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Its couriers do not reach 12 Example Street, Kedron QLD 4031.',
    );
    expect(within(alert).getByRole('link', { name: 'Back to cart' }).getAttribute('href')).toBe(
      '/cart',
    );
    fireEvent.click(within(alert).getByRole('button', { name: 'Change address' }));
    expect(document.activeElement?.textContent).toBe('Delivery address');
    expect(payOff()).toBe(true);
  });

  it('drops a late answer for an address the buyer has left', async () => {
    const answers: Record<string, (value: Record<string, unknown>) => void> = {};
    deliveryQuotesFor.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          answers[(request as { address: { id: string } }).address.id] = resolve;
        }),
    );
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /^Sam Nguyen/ }));
    await waitFor(() => expect(answers.work).toBeDefined());
    act(() =>
      answers.work!({
        kedron: { kind: 'quote', express: aud(990) },
        paddington: { kind: 'quote', express: null },
      }),
    );
    await screen.findByRole('radio', { name: /Express.*A\$9\.90/ });
    // Home's answer arrives after Work's: it is not shown.
    act(() =>
      answers.home!({
        kedron: { kind: 'quote', express: aud(1290) },
        paddington: { kind: 'quote', express: null },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('radio', { name: /Express.*A\$12\.90/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Express.*A\$9\.90/ })).toBeTruthy();
  });

  it('updates the total to a new Express price, and keeps Express wished through a failure', async () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(await screen.findByRole('radio', { name: /Express.*A\$12\.90/ }));
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$73.30 with Stripe'));
    // Another address prices Express differently; the total follows.
    deliveryQuotesFor.mockResolvedValueOnce({
      kedron: { kind: 'quote', express: aud(1590) },
      paddington: { kind: 'quote', express: null },
    });
    fireEvent.click(screen.getByRole('radio', { name: /^Sam Nguyen/ }));
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$76.30 with Stripe'));
    // A failed quote shows Scheduled only and holds Pay; Try again brings Express back.
    deliveryQuotesFor.mockResolvedValueOnce({
      kedron: { kind: 'failed' },
      paddington: { kind: 'quote', express: null },
    });
    fireEvent.click(screen.getByRole('radio', { name: /^Alex Nguyen/ }));
    const failed = await screen.findByRole('alert');
    expect(screen.queryByRole('radio', { name: /Express.*A\$/ })).toBeNull();
    expect(payOff()).toBe(true);
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    const express = await screen.findByRole('radio', { name: /Express.*A\$12\.90/ });
    expect(express).toHaveProperty('checked', true);
    await waitFor(() => expect(payButtons()[0]!.textContent).toBe('Pay A$73.30 with Stripe'));
  });

  it('turns Express off until there is an address to price', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    expect(screen.getAllByText('Choose an address to see the price.')).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /Express/ })).toBeNull();
    // Pay says why it is off, and a press takes the buyer to the first missing field.
    const pay = payButtons()[0]!;
    const reason = document.getElementById(pay.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toBe('Complete the new address above to pay.');
    fireEvent.click(pay);
    expect(push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Address' }));
  });

  it('holds Pay offline, and asks failed prices again when the connection is back', async () => {
    deliveryQuotesFor.mockResolvedValueOnce({
      kedron: { kind: 'failed' },
      paddington: { kind: 'quote', express: null },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    await screen.findByRole('alert');
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
    await waitFor(() => expect(payOff()).toBe(false));
    expect(deliveryQuotesFor).toHaveBeenLastCalledWith({
      address: { kind: 'saved', id: 'home' },
      sellerIds: ['kedron'],
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
    await waitFor(() => expect(payOff()).toBe(false));
    expect(deliveryQuotesFor).toHaveBeenLastCalledWith({
      address: { kind: 'new', postcode: '4031' },
      sellerIds: ['kedron', 'paddington'],
    });
    fireEvent.click(payButtons()[0]!);
    expect(push).toHaveBeenCalledWith('/checkout/payment');
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
    expect(screen.getByRole('status').textContent).toContain('No addresses found.');
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
    await waitFor(() => expect(payOff()).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
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
    expect(view.delivery).toEqual(aud(1250));
    expect(view.total).toEqual(aud(5540 - 554 + 1250));
    const source: CartSource = {
      items: { a: { name: 'Lamb', sellerId: 's', category: 'meat', price: aud(1000) } },
      sellers: {
        s: {
          id: 's',
          name: 'Seller',
          deliveryWindow: 'Today',
          minimumOrder: aud(1000),
          deliveryFee: aud(400),
        },
      },
      tax: { share: { numerator: 1, denominator: 11 }, includesDelivery: true },
      sampleDiscounts: {},
    };
    const minimum = viewCart({ a: { quantity: 1, unitPrice: aud(1000), limit: 12 } }, source, {
      code: 'X',
      percentOff: 10,
    })!;
    expect(minimum.blocked).toEqual([]);
    expect(minimum.total).toEqual(aud(900 + 400));
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
    expect(screen.getAllByText('A$62.36').length).toBeGreaterThan(0);
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
    expect(screen.getAllByText('A$54.40').length).toBeGreaterThan(0);
    fireEvent.click(within(saved).getByRole('button', { name: `Move ${name} to cart` }));
    expect(screen.queryByRole('region', { name: /Saved for later/ })).toBeNull();
    expect(screen.getAllByText('A$67.90').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: `Save ${name} for later` }));
    fireEvent.click(screen.getByRole('button', { name: `Remove ${name} from saved items` }));
    expect(screen.queryByRole('region', { name: /Saved for later/ })).toBeNull();
  });

  it('keeps a seller note and the Express choice up to the confirmation', async () => {
    renderWith(
      <>
        <CheckoutPage source={SAMPLE_CHECKOUT} />
        <SamplePayment reference="MP-1" />
        <Confirmation />
      </>,
      MET,
      true,
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Express.*A\$12\.90/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a note for this seller' })[0]!);
    const note = screen.getByLabelText(/^Note for Kedron Halal Butchers/);
    expect(note.getAttribute('maxlength')).toBe('200');
    expect(document.activeElement).toBe(note);
    fireEvent.change(note, { target: { value: '<b>Ring the bell</b>' } });
    expect(screen.getByText('20 / 200')).toBeTruthy();
    // The delivery choice is taken when Pay is pressed.
    fireEvent.click(screen.getAllByRole('button', { name: /^Pay A\$/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Complete the sample payment' }));
    const part = screen.getByRole('heading', { name: 'Kedron Halal Butchers' }).closest('article')!;
    expect(within(part).getByText('<b>Ring the bell</b>')).toBeTruthy();
    expect(part.querySelector('p b b')).toBeNull();
    expect(within(part).getByText('Order MP-1-1 · Delivery: Express, within 2 hours')).toBeTruthy();
    const other = screen.getByRole('heading', { name: 'Paddington Bakehouse' }).closest('article')!;
    expect(within(other).getByText(/^Order MP-1-2 · Delivery: Scheduled, /)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Payment summary' })).toBeTruthy();
  });
});
