// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { CartDrawer } from '../src/cart/cart-drawer.tsx';
import { CartPage } from '../src/cart/cart-page.tsx';
import { viewCart, type Cart } from '../src/cart/cart.ts';
import { CheckoutPage, inServiceArea } from '../src/checkout/checkout-page.tsx';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';
import type { CartSource } from '../src/storefront/types.ts';

const push = vi.fn();
const scrolled = vi.fn();
const replace = vi.fn();
let path = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push, replace }),
}));

beforeEach(() => {
  path = '/';
  push.mockReset();
  replace.mockReset();
  Element.prototype.scrollIntoView = scrolled;
  scrolled.mockReset();
});
afterEach(cleanup);

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
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Minimum order not reached')).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: 'Checkout' })) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
    }
    expect(push).not.toHaveBeenCalled();
    expect(scrolled).toHaveBeenCalled();
  });

  it('goes to checkout once every seller meets its minimum, with the GST line', () => {
    renderWith(<CartPage />, MET);
    expect(screen.queryByRole('alert')).toBeNull();
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
  it('asks a guest to log in or create an account, keeping the cart', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET);
    expect(screen.getByText('Step 1 of 4')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Log in' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Create account' }));
    expect(screen.getByLabelText('Full name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create account and continue' }));
    expect(screen.getByText('Signed in as alex.nguyen@example.com')).toBeTruthy();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
  });

  it('refuses a new address outside the service area, then walks to payment', () => {
    renderWith(<CheckoutPage source={SAMPLE_CHECKOUT} />, MET, true);
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    const deliver = screen.getByRole('button', { name: 'Deliver to this address' });
    expect(deliver.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '4210' } });
    expect(screen.getByRole('alert').textContent).toBe(
      'We do not deliver to 4210 yet. We currently deliver to Greater Brisbane.',
    );
    fireEvent.click(screen.getByRole('radio', { name: /Home/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Deliver to this address' }));
    expect(screen.getByText('Home: 12 Example Street, Kedron QLD 4031')).toBeTruthy();
    expect(
      screen.getByText(
        'Each seller prepares and delivers its own part of your order, so you may receive more than one delivery.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(screen.getByText('2 deliveries, A$12.50 total')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pay A$67.90 on Stripe' }).getAttribute('href')).toBe(
      '/checkout/payment',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change Delivery address' }));
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
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
