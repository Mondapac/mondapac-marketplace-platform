// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import type { Cart } from '../src/cart/cart.ts';
import { CheckoutPage } from '../src/checkout/checkout-page.tsx';
import { firstFieldToFix } from '../src/checkout/focus-error.ts';
import { isCheckoutFocusPath } from '../src/shell/checkout-focus.tsx';
import { StoreProvider, useStore } from '../src/shell/store-context.tsx';
import { StoreShell } from '../src/shell/store-shell.tsx';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR } from '../src/storefront/sample-delivery.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import type { CartSource, CheckoutSource } from '../src/storefront/types.ts';

let path = '/checkout';
const { deliveryAreaFor, deliveryQuotesFor, payOrder } = vi.hoisted(() => ({
  deliveryAreaFor: vi.fn(),
  deliveryQuotesFor: vi.fn(),
  payOrder: vi.fn(),
}));
vi.mock('../src/checkout/actions.ts', () => ({ deliveryAreaFor, deliveryQuotesFor, payOrder }));
vi.mock('next/navigation', () => ({
  usePathname: () => path,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const scrolled = vi.fn();
beforeEach(() => {
  path = '/checkout';
  deliveryAreaFor.mockReset();
  payOrder.mockReset();
  deliveryQuotesFor.mockReset();
  deliveryQuotesFor.mockImplementation((request: { sellerIds: string[] }) =>
    Promise.resolve(
      Object.fromEntries(request.sellerIds.map((id) => [id, { kind: 'quote', express: null }])),
    ),
  );
  Element.prototype.scrollIntoView = scrolled;
  scrolled.mockReset();
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

function SignIn() {
  const { setCustomer } = useStore();
  useLayoutEffect(() => setCustomer(SAMPLE_CHECKOUT.customer), [setCustomer]);
  return null;
}

function intl(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  );
}

const AU_CART: Cart = {
  brisket: { quantity: 1, unitPrice: SAMPLE_CART_SOURCE.items.brisket!.price, limit: 12 },
  sourdough: { quantity: 1, unitPrice: SAMPLE_CART_SOURCE.items.sourdough!.price, limit: 12 },
};

// A synthetic second Market: another currency, region and postcode shape (letters allowed).
const nzd = (amount: number) => ({ amount, currency: 'NZD' });
const NZ_CART_SOURCE: CartSource = {
  items: { jam: { name: 'Feijoa jam', sellerId: 's', category: 'pantry', price: nzd(900) } },
  sellers: {
    s: { id: 's', name: 'Auckland Pantry', deliveryWindow: 'Today', deliveryFee: nzd(400) },
  },
  tax: { share: { numerator: 3, denominator: 23 }, includesDelivery: true },
  sampleDiscounts: {},
};
const NZ_CART: Cart = { jam: { quantity: 2, unitPrice: nzd(900), limit: 12 } };
const NZ_CHECKOUT: CheckoutSource = {
  ...SAMPLE_CHECKOUT,
  serviceArea: {
    name: 'Auckland',
    region: 'Auckland',
    regionCode: 'AKL',
    postcodes: [{ from: '0600', to: '2699' }],
  },
};

function renderCheckout(source: CheckoutSource, cartSource: CartSource, cart: Cart) {
  return render(
    intl(
      <StoreProvider cartSource={cartSource} initialCart={cart}>
        <SignIn />
        <CheckoutPage source={source} />
      </StoreProvider>,
    ),
  );
}

function renderShell() {
  return render(
    intl(
      <StoreShell
        content={SAMPLE_CONTENT}
        cartSource={SAMPLE_CART_SOURCE}
        locator={SAMPLE_DELIVERY_LOCATOR}
        deliverTo={null}
        consent={null}
        signIn={SAMPLE_CHECKOUT.customer}
      >
        <p>page</p>
      </StoreShell>,
    ),
  );
}

describe('checkout focus mode', () => {
  it('covers the checkout and payment pages, not the confirmation or not-completed ones', () => {
    for (const p of ['/checkout', '/checkout/', '/checkout/payment'])
      expect(isCheckoutFocusPath(p), p).toBe(true);
    for (const p of ['/', '/cart', '/checkout/confirmation', '/checkout/not-completed', null])
      expect(isCheckoutFocusPath(p), String(p)).toBe(false);
  });

  it('renders no tab bar and shows the simple header on checkout and payment', () => {
    for (const p of ['/checkout', '/checkout/payment']) {
      path = p;
      const { container, unmount } = renderShell();
      expect(container.querySelector('.tabbar'), p).toBeNull();
      expect(container.querySelector('.frame')!.getAttribute('data-focus')).toBe('checkout');
      const header = container.querySelector<HTMLElement>('.cfh')!;
      expect(within(header).getByText('Secure checkout')).toBeTruthy();
      expect(within(header).getByRole('link', { name: 'Back to cart' }).getAttribute('href')).toBe(
        '/cart',
      );
      expect(within(header).getByRole('link', { name: /Mondapac|Monda/i })).toBeTruthy();
      unmount();
    }
  });

  it('keeps the tab bar and no focus header on other pages', () => {
    for (const p of ['/', '/checkout/confirmation', '/checkout/not-completed']) {
      path = p;
      const { container, unmount } = renderShell();
      expect(container.querySelector('.tabbar'), p).not.toBeNull();
      expect(container.querySelector('.cfh'), p).toBeNull();
      expect(container.querySelector('.frame')!.hasAttribute('data-focus'), p).toBe(false);
      unmount();
    }
  });

  it('hides the footer and the full header below 900px, and the Pay bar while the keyboard is open', () => {
    const css = readFileSync(join(import.meta.dirname, '../app/globals.css'), 'utf8');
    const block = css.slice(css.indexOf('Checkout focus mode (M2'));
    const phone = block.slice(block.indexOf('@media (max-width: 899.98px)'));
    expect(phone).toMatch(
      /\.frame\[data-focus\] \.top,\s*\.frame\[data-focus\] \.foot \{\s*display: none;/,
    );
    expect(block).toMatch(/:root\[data-keyboard='open'\] \.paybar \{\s*display: none;/);
    expect(phone).toContain('env(safe-area-inset-bottom, 0px)');
    // Logical properties only: no physical left or right in the focus block.
    expect(block.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /(margin|padding|border)-(left|right)|\b(left|right):/,
    );
  });
});

describe('sticky Pay bar', () => {
  it('shows the total in the order currency for the AU market', async () => {
    const { container } = renderCheckout(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    const bar = container.querySelector<HTMLElement>('.paybar')!;
    const pay = within(bar).getByRole('button', { name: /^Pay / });
    expect(pay.textContent).toBe('Pay A$67.90');
    await waitFor(() => expect(pay.getAttribute('aria-disabled')).toBeNull());
  });

  it('shows the total in another currency for a synthetic NZD market', async () => {
    const { container } = renderCheckout(NZ_CHECKOUT, NZ_CART_SOURCE, NZ_CART);
    const bar = container.querySelector<HTMLElement>('.paybar')!;
    await waitFor(() => expect(within(bar).getByRole('button').textContent).toMatch(/^Pay NZ\$/));
    expect(within(bar).getByRole('button').textContent).toBe('Pay NZ$22.00');
    expect(bar.textContent).not.toContain('A$');
  });

  it('is the same action as the form Pay button, not a second code path', async () => {
    payOrder.mockResolvedValue({ kind: 'failed' });
    const { container } = renderCheckout(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    const bar = container.querySelector<HTMLElement>('.paybar')!;
    const pay = within(bar).getByRole('button');
    await waitFor(() => expect(pay.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(pay);
    await waitFor(() => expect(payOrder).toHaveBeenCalledTimes(1));
  });
});

describe('order summary disclosure', () => {
  it('is a button with aria-expanded and aria-controls, showing the item count and total', () => {
    const { container } = renderCheckout(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    const toggle = container.querySelector<HTMLButtonElement>('.cmob-btn')!;
    expect(toggle.textContent).toContain('Order summary');
    expect(toggle.textContent).toContain('2 items');
    expect(toggle.textContent).toContain('A$67.90');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hasAttribute('hidden')).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(within(panel).getByText('Kedron Halal Butchers')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('address fields', () => {
  function manualFields(source: CheckoutSource, cartSource: CartSource, cart: Cart) {
    renderCheckout(source, cartSource, cart);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter address manually' }));
  }
  const input = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

  it('sets autofill and keyboard hints, with a numeric postcode only where the market says so', () => {
    manualFields(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    expect(input('Mobile number').type).toBe('tel');
    expect(input('Mobile number').getAttribute('autocomplete')).toBe('tel');
    expect(input('Full name').getAttribute('autocomplete')).toBe('name');
    expect(input('Street address and unit').getAttribute('autocomplete')).toBe('address-line1');
    expect(input('Suburb').getAttribute('autocomplete')).toBe('address-level2');
    expect(input('State').getAttribute('autocomplete')).toBe('address-level1');
    expect(input('Postcode').getAttribute('autocomplete')).toBe('postal-code');
    expect(input('Postcode').getAttribute('inputmode')).toBe('numeric');
  });

  it('asks for the text keyboard when the market does not say the postcode is numeric', () => {
    manualFields(NZ_CHECKOUT, NZ_CART_SOURCE, NZ_CART);
    expect(input('Postcode').getAttribute('inputmode')).toBe('text');
    expect(input('Postcode').getAttribute('autocomplete')).toBe('postal-code');
    expect(input('State').getAttribute('autocomplete')).toBe('address-level1');
  });

  it('types the email field as email with autofill on the guest step', () => {
    // The guest step is gone once the fixture signs in, so read the field's props from the source.
    const src = readFileSync(
      join(import.meta.dirname, '../src/checkout/checkout-page.tsx'),
      'utf8',
    );
    expect(src).toContain('type="email" autoComplete="email"');
  });
});

describe('first error', () => {
  it('finds the first invalid field before an empty one, skipping read-only and radios', () => {
    document.body.innerHTML = `
      <div id="r">
        <input type="radio" />
        <input readonly value="" />
        <input id="empty" value="" />
        <input id="bad" value="x" aria-invalid="true" />
      </div>`;
    const root = document.getElementById('r')!;
    expect(firstFieldToFix(root)?.id).toBe('bad');
    document.getElementById('bad')!.removeAttribute('aria-invalid');
    expect(firstFieldToFix(root)?.id).toBe('empty');
    document.getElementById('empty')!.setAttribute('value', 'y');
    (document.getElementById('empty') as HTMLInputElement).value = 'y';
    expect(firstFieldToFix(root)).toBeNull();
  });

  it('scrolls to and focuses the first empty address field when Pay is pressed too early', () => {
    renderCheckout(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    fireEvent.click(screen.getByRole('radio', { name: /Add a new address/ }));
    const bar = document.querySelector<HTMLElement>('.paybar')!;
    const pay = within(bar).getByRole('button');
    expect(pay.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      fireEvent.click(pay);
    });
    const section = document.getElementById('checkout-address')!;
    const active = document.activeElement as HTMLInputElement;
    expect(section.contains(active)).toBe(true);
    expect(active.tagName).toBe('INPUT');
    expect(scrolled).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
  });
});
