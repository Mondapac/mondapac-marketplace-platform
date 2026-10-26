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
import { Dock } from '../src/shell/dock.tsx';
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
      expect(
        within(header)
          .getByRole('link', { name: /Back to cart/ })
          .getAttribute('href'),
      ).toBe('/cart');
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
    // The page gutters are physical insets, so they are used physically (as .consent does).
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/(padding|margin)-inline:[^;]*var\(--g[lr]\)/);
    expect(code).toContain('padding-left: var(--gl);');
    expect(code).toContain('padding-right: var(--gr);');
  });

  it('puts the home-indicator inset on the bottom-most layer only', () => {
    const css = readFileSync(join(import.meta.dirname, '../app/globals.css'), 'utf8');
    const block = css.slice(css.indexOf('Checkout focus mode (M2'));
    // The cookie bar carries it in focus mode; the Pay bar only when the dock is empty.
    expect(block).toMatch(
      /\.frame\[data-focus\] \.consent \{\s*padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\);/,
    );
    expect(block).toContain('padding-bottom: calc(10px + var(--sf-dock-inset');
  });

  it('keeps the checkout fields at 16px on phones and tablets, and one Pay (the bar) there', () => {
    const css = readFileSync(join(import.meta.dirname, '../app/globals.css'), 'utf8');
    const phone = css.slice(css.indexOf('Checkout focus mode (M2'));
    expect(phone).toMatch(
      /\.fld input,\s*\.fld textarea,\s*\.ckdc input \{\s*font-size: max\(16px, 1em\);/,
    );
    expect(phone).toMatch(/\.ckpm \{\s*display: none;/);
    expect(phone).toContain('max-inline-size: 560px');
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
    // The state is fixed by the service area (read-only): nothing to autofill.
    expect(input('State').getAttribute('autocomplete')).toBeNull();
    expect(input('Postcode').getAttribute('autocomplete')).toBe('postal-code');
    expect(input('Postcode').getAttribute('inputmode')).toBe('numeric');
  });

  it('asks for the text keyboard when the market does not say the postcode is numeric', () => {
    manualFields(NZ_CHECKOUT, NZ_CART_SOURCE, NZ_CART);
    expect(input('Postcode').getAttribute('inputmode')).toBe('text');
    expect(input('Postcode').getAttribute('autocomplete')).toBe('postal-code');
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
  it('finds the first invalid or empty field in page order, skipping read-only and radios', () => {
    document.body.innerHTML = `
      <div id="r">
        <input type="radio" />
        <input readonly value="" />
        <input id="empty" value="" />
        <input id="bad" value="x" aria-invalid="true" />
      </div>`;
    const root = document.getElementById('r')!;
    // Page order: the empty field comes before the invalid one.
    expect(firstFieldToFix(root)?.id).toBe('empty');
    (document.getElementById('empty') as HTMLInputElement).value = 'y';
    expect(firstFieldToFix(root)?.id).toBe('bad');
    document.getElementById('bad')!.removeAttribute('aria-invalid');
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

describe('focus header, summary and Pay bar details', () => {
  it('has Cart, the logo and a short Secure label in one row, with the full labels for 700px', () => {
    const { container } = renderShell();
    const row = container.querySelector<HTMLElement>('.cfh-in')!;
    expect([...row.children].map((c) => c.className.split(' ')[0])).toEqual([
      'cfh-back',
      'logo',
      'cfh-secure',
    ]);
    expect(row.querySelector('.cfh-back .short')!.textContent).toBe('Cart');
    expect(row.querySelector('.cfh-back .long')!.textContent).toBe('Back to cart');
    expect(row.querySelector('.cfh-secure .short')!.textContent).toBe('Secure');
    expect(row.querySelector('.cfh-secure .long')!.textContent).toBe('Secure checkout');
  });

  it('says the terms in the Pay bar, with real links', () => {
    const { container } = renderCheckout(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    const bar = container.querySelector<HTMLElement>('.paybar')!;
    expect(bar.querySelector('.legal')!.textContent).toContain('By placing your order you agree');
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/terms', '/privacy']);
  });

  it('does not repeat the summary title inside the opened disclosure', () => {
    const { container } = renderCheckout(SAMPLE_CHECKOUT, SAMPLE_CART_SOURCE, AU_CART);
    const panel = container.querySelector<HTMLElement>('.cmob .cs')!;
    expect(panel.querySelector('h2')).toBeNull();
    expect(within(panel).getByText('Kedron Halal Butchers')).toBeTruthy();
  });
});

describe('dock inset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const inset = () => document.documentElement.style.getPropertyValue('--sf-dock-inset');

  it('adds the home-indicator inset above an empty dock and none above an occupied one', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get');
    height.mockReturnValue(0);
    const empty = render(<Dock>{null}</Dock>);
    expect(inset()).toContain('safe-area-inset-bottom');
    empty.unmount();
    expect(inset()).toBe('');
    height.mockReturnValue(120);
    const full = render(
      <Dock>
        <div className="consent" />
      </Dock>,
    );
    expect(inset()).toBe('0px');
    full.unmount();
  });
});
