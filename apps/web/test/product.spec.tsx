// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { ProductPage } from '../src/product/product-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import { loadProduct } from '../src/storefront/source.ts';
import type { ProductDetail } from '../src/storefront/types.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The layout the test runs in: desktop (1000px and wider) or phone and tablet. */
function layout(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 1000px') && wide,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

async function product(id: string): Promise<ProductDetail> {
  const found = await loadProduct(id);
  if (!found) throw new Error(`no sample product ${id}`);
  return found;
}

async function renderPage(id = 'whole-chicken') {
  const detail = await product(id);
  const category = SAMPLE_CONTENT.categories.find((c) => c.code === detail.category);
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <ProductPage product={detail} category={category} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('product sample source', () => {
  it('gives the featured offer the product id, so the card and the page share a cart line', async () => {
    const chicken = await product('whole-chicken');
    expect(chicken.offers.map((o) => o.id)).toEqual([
      'whole-chicken',
      'whole-chicken:mt-gravatt',
      'whole-chicken:logan-road',
    ]);
    expect(chicken.offers[0].certifications).toEqual([{ type: 'halal', label: 'Halal certified' }]);
    expect(chicken.similar).toHaveLength(6);
    expect(chicken.similar.map((p) => p.id)).not.toContain('whole-chicken');
  });

  it('answers undefined for an unknown product', async () => {
    expect(await loadProduct('no-such-product')).toBeUndefined();
  });
});

describe('product page', () => {
  it('has one h1, the trail to the category and the buy box facts', async () => {
    layout(true);
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Free-range chicken, whole',
    ]);
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Poultry' }).getAttribute('href')).toBe(
      '/c/poultry',
    );
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    expect(within(box).getByText('A$22.90')).toBeTruthy();
    expect(within(box).getByText('Only 3 left')).toBeTruthy();
    expect(within(box).getByRole('link', { name: /2 other sellers from A\$21\.90/ })).toBeTruthy();
    const photo = document.querySelector<HTMLElement>('.gmain')!;
    expect(within(photo).getByRole('img', { name: 'Halal certified' })).toBeTruthy();
    expect(screen.getByText(/Issued to Kedron Halal Butchers/)).toBeTruthy();
    expect(screen.getByText('Weight')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Similar products' })).toBeTruthy();
  });

  it('switches the photo from a thumbnail', async () => {
    layout(true);
    await renderPage();
    const thumbs = within(screen.getByRole('group', { name: 'Photos' })).getAllByRole('button');
    expect(thumbs).toHaveLength(4);
    fireEvent.click(thumbs[2]!);
    expect(thumbs[2]!.getAttribute('aria-current')).toBe('true');
    expect(thumbs[0]!.getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('img', { name: 'Free-range chicken, whole' }).getAttribute('src')).toBe(
      '/placeholders/egg.jpg',
    );
  });

  it('adds to the cart up to the units left, in the buy box and the buy bar alike', async () => {
    layout(true);
    await renderPage();
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    fireEvent.click(within(box).getByRole('button', { name: 'Add to cart' }));
    const increase = within(box).getByRole('button', { name: 'Increase' });
    fireEvent.click(increase);
    fireEvent.click(increase);
    expect(within(box).getByText('3')).toBeTruthy();
    expect((increase as HTMLButtonElement).disabled).toBe(true);
    expect(within(box).getByText('In your cart (maximum for this item)')).toBeTruthy();
    // The buy bar steps the same line.
    expect(screen.getAllByRole('group', { name: 'Quantity' })).toHaveLength(2);
  });

  it('adds another seller as its own line', async () => {
    layout(true);
    await renderPage();
    const others = screen.getByRole('region', { name: 'Other sellers' });
    fireEvent.click(
      within(others).getByRole('button', { name: 'Add to cart from Logan Road Meats' }),
    );
    expect(within(others).getByRole('group', { name: 'Quantity' })).toBeTruthy();
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    expect(within(box).getByRole('button', { name: 'Add to cart' })).toBeTruthy();
  });

  it('opens the seller card on hover on the desktop and closes it when the pointer leaves', async () => {
    layout(true);
    vi.useFakeTimers();
    await renderPage();
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    const name = within(box).getByRole('button', { name: 'Kedron Halal Butchers' });
    const card = document.getElementById(name.getAttribute('aria-controls')!)!;
    expect(card.hidden).toBe(true);
    fireEvent.mouseEnter(name.closest('.sw')!);
    expect(card.hidden).toBe(false);
    expect(name.getAttribute('aria-expanded')).toBe('true');
    expect(within(card).getByText('96%')).toBeTruthy();
    expect(within(card).getByText('Halal certificate checked')).toBeTruthy();
    fireEvent.mouseLeave(name.closest('.sw')!);
    expect(card.hidden).toBe(false);
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(card.hidden).toBe(true);
  });

  it('keeps one card open and closes it on Esc and on an outside click', async () => {
    layout(true);
    await renderPage();
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    const first = within(box).getByRole('button', { name: 'Kedron Halal Butchers' });
    const second = screen.getByRole('button', { name: 'Logan Road Meats' });
    fireEvent.click(first);
    fireEvent.click(second);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(second.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('heading', { level: 1 }));
    expect(first.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens Seller info as a modal on phone and tablet, and gives focus back on close', async () => {
    layout(false);
    await renderPage();
    const row = screen.getByRole('region', { name: 'Other sellers' });
    const info = within(row).getByRole('button', { name: 'Details of Logan Road Meats' });
    fireEvent.mouseEnter(info.closest('.sw')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(info);
    const dialog = screen.getByRole('dialog', { name: 'Logan Road Meats' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    expect(within(dialog).getByText('Brisbane, selling since 2026')).toBeTruthy();
    expect(within(dialog).queryByText(/certificate checked/)).toBeNull();
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(info);
    fireEvent.click(info);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves out certificates and other sellers when the product has none', async () => {
    layout(true);
    await renderPage('sourdough');
    expect(screen.queryByRole('heading', { name: 'Certificates' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Other sellers' })).toBeNull();
    expect(screen.queryByRole('link', { name: /other sellers? from/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Photos' })).toBeNull();
  });
});
