// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { HomeSections } from '../src/home/home-sections.tsx';
import { StoreShell } from '../src/shell/store-shell.tsx';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import type { StorefrontContent } from '../src/storefront/types.ts';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

function renderStore(content: StorefrontContent = SAMPLE_CONTENT) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreShell content={content} textSize="auto">
        <HomeSections
          sections={content.home}
          categories={content.categories}
          sellers={content.sellers}
        />
      </StoreShell>
    </NextIntlClientProvider>,
  );
}

describe('home page', () => {
  it('has one h1 and the sections of the layout in order', () => {
    renderStore();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(
      expect.arrayContaining(['Sellers near you', 'Best sellers', 'Special prices this week']),
    );
  });

  it('shows the price with its currency and GST note, and the seal from the badge', () => {
    renderStore();
    const card = screen.getAllByRole('article')[0]!;
    expect(within(card).getByText('A$24.90')).toBeTruthy();
    expect(within(card).getByText('including GST')).toBeTruthy();
    expect(within(card).getByRole('img', { name: 'Halal certified' })).toBeTruthy();
  });

  it('adds to the cart, updates the header total and stops at the units left', () => {
    renderStore();
    const add = screen.getAllByRole('button', {
      name: 'Add Free-range chicken, whole to cart',
    })[0]!;
    fireEvent.click(add);
    expect(screen.getByRole('link', { name: 'Cart, 1 item, A$22.90' })).toBeTruthy();
    const group = screen.getAllByRole('group', {
      name: 'Quantity of Free-range chicken, whole',
    })[0]!;
    fireEvent.click(within(group).getByRole('button', { name: 'Increase' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Increase' }));
    // Three left: the plus button stops at three.
    expect(within(group).getByRole('button', { name: 'No more in stock' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('link', { name: 'Cart, 3 items, A$68.70' })).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Decrease' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Decrease' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Decrease' }));
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: 'Cart, empty' }),
    ).toBeTruthy();
  });

  it('shows an empty state for a section without products or sellers', () => {
    renderStore({
      ...SAMPLE_CONTENT,
      sellers: [],
      home: [
        { kind: 'sellers', title: 'Sellers near you', href: '/sellers' },
        { kind: 'products', title: 'Best sellers', href: '/best-sellers', products: [] },
      ],
    });
    expect(screen.getByText('No sellers deliver to this area yet.')).toBeTruthy();
    expect(screen.getByText('Nothing to show here yet. Check back soon.')).toBeTruthy();
  });

  it('formats prices of another Market in its own currency', () => {
    const nz = SAMPLE_CONTENT.home.find((s) => s.kind === 'products');
    if (nz?.kind !== 'products') throw new Error('no product section');
    const product = { ...nz.products[0]!, price: { amount: 1250, currency: 'NZD' } };
    renderStore({
      ...SAMPLE_CONTENT,
      home: [{ kind: 'products', title: 'Best sellers', href: '/x', products: [product] }],
    });
    expect(screen.getByText('NZ$12.50')).toBeTruthy();
  });
});

describe('browse products panel', () => {
  it('opens from the bottom bar, goes into a category, back, and closes with Escape', () => {
    const { container } = renderStore();
    const wrap = container.querySelector('.pwrap')!;
    expect(wrap.classList.contains('open')).toBe(false);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'App navigation' })).getByRole('button', {
        name: 'Browse',
      }),
    );
    expect(wrap.classList.contains('open')).toBe(true);
    // The page behind the open panel takes no focus.
    expect(container.querySelector('.frame')!.hasAttribute('inert')).toBe(true);
    const panel = screen.getByRole('dialog', { name: 'Browse products' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Dairy and eggs' }));
    const dairy = screen.getByRole('dialog', { name: 'Dairy and eggs' });
    expect(within(dairy).getByRole('link', { name: 'Dips and hummus' })).toBeTruthy();
    fireEvent.click(within(dairy).getByRole('button', { name: 'Back to Browse products' }));
    expect(screen.getByRole('dialog', { name: 'Browse products' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(wrap.classList.contains('open')).toBe(false);
    expect(container.querySelector('.frame')!.hasAttribute('inert')).toBe(false);
  });
});

describe('search view', () => {
  it('opens from the bottom bar with the popular searches and closes', () => {
    const { container } = renderStore();
    const view = container.querySelector('.sview') as HTMLElement;
    expect(view.hidden).toBe(true);
    const bar = screen.getByRole('navigation', { name: 'App navigation' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Search' }));
    expect(view.hidden).toBe(false);
    expect(within(view).getByRole('link', { name: 'Basmati rice' })).toBeTruthy();
    fireEvent.click(within(view).getByRole('button', { name: 'Close search' }));
    expect(view.hidden).toBe(true);
  });
});
