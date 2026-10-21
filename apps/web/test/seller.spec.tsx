// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { heat } from '../src/seller/rings.tsx';
import { SellerPage } from '../src/seller/seller-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SELLER_RATINGS_SHOWN } from '../src/storefront/features.ts';
import { loadSeller } from '../src/storefront/source.ts';
import type { CompleteSellerShop } from '../src/storefront/types.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A sample seller (no API is configured in tests, so every part is known). */
async function seller(slug: string): Promise<CompleteSellerShop> {
  const found = await loadSeller(slug);
  if (!found) throw new Error(`no sample seller ${slug}`);
  return found as CompleteSellerShop;
}

async function renderPage(slug = 'kedron', ratingsShown = false) {
  const shop = await seller(slug);
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <SellerPage shop={shop} ratingsShown={ratingsShown} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

const count = () => document.querySelector('.shop-count')?.textContent;

const cardNames = () =>
  screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');

describe('seller sample source', () => {
  it('gives the seller its own products, their categories and its certificate', async () => {
    const kedron = await seller('kedron');
    expect(kedron.products).toHaveLength(6);
    expect(kedron.products.every((p) => p.sellerName === 'Kedron Halal Butchers')).toBe(true);
    expect(kedron.categories.map((c) => c.code)).toEqual(['meat', 'poultry']);
    expect(kedron.certificates.map((c) => [c.type, c.name])).toEqual([['halal', 'Halal']]);
    expect(kedron.minimumOrder).toEqual({ amount: 4000, currency: 'AUD' });
  });

  it('has a new seller without ratings or products, and no unknown sellers', async () => {
    const coorparoo = await seller('coorparoo');
    expect(coorparoo.ratings).toBeUndefined();
    expect(coorparoo.products).toEqual([]);
    expect(coorparoo.logo).toBeUndefined();
    expect(await loadSeller('no-such-seller')).toBeUndefined();
  });
});

describe('ring colour', () => {
  it('runs from red at 50 or less to dark green at 100, interpolated between the stops', () => {
    expect(heat(20)).toBe('rgb(198, 40, 40)');
    expect(heat(50)).toBe('rgb(198, 40, 40)');
    expect(heat(78)).toBe('rgb(242, 194, 0)');
    expect(heat(84)).toBe('rgb(183, 187, 33)');
    expect(heat(100)).toBe('rgb(27, 94, 32)');
  });
});

describe('seller page header', () => {
  it('has one h1, no breadcrumb, and the facts as chips', async () => {
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Kedron Halal Butchers',
    ]);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).toBeNull();
    expect(screen.getByText('Kedron, Brisbane')).toBeTruthy();
    expect(screen.getByText('Selling since 2025')).toBeTruthy();
    const chips = document.querySelector<HTMLElement>('.shop-chips')!;
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Halal certificate checked',
      'Tomorrow 8am-12pm',
      'A$40.00 minimum order',
      'Delivery A$7.50',
    ]);
  });

  it('keeps the performance rings off by default', async () => {
    expect(SELLER_RATINGS_SHOWN).toBe(false);
    await renderPage();
    expect(screen.queryByRole('group', { name: 'Seller performance' })).toBeNull();
  });

  it('shows the three rings with their values in words when the feature is on', async () => {
    await renderPage('kedron', true);
    const rings = screen.getByRole('group', { name: 'Seller performance' });
    expect(
      within(rings)
        .getAllByRole('img')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Satisfaction: 96 percent', 'On time: 98 percent', 'As described: 99 percent']);
    expect(within(rings).getByText('96%')).toBeTruthy();
  });

  it('marks a new seller and shows no rings for it', async () => {
    await renderPage('coorparoo', true);
    expect(screen.queryByRole('group', { name: 'Seller performance' })).toBeNull();
    expect(screen.getByText('New seller')).toBeTruthy();
    expect(screen.getByText('No minimum order')).toBeTruthy();
    expect(screen.queryByText(/certificate checked/)).toBeNull();
  });
});

describe('share menu', () => {
  it('opens on the pill, offers the channels with the /s/ link, and Esc returns focus', async () => {
    await renderPage();
    const pill = screen.getByRole('button', { name: 'Share' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(pill);
    const menu = screen.getByRole('menu', { name: 'Share this shop' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Copy link', 'WhatsApp', 'Email']);
    expect(document.activeElement).toBe(items[0]);
    expect(items[1]!.getAttribute('href')).toContain(
      encodeURIComponent('http://localhost:3000/s/kedron'),
    );
    expect(items[2]!.getAttribute('href')).toMatch(/^mailto:\?subject=Kedron/);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  it('copies the link and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('http://localhost:3000/s/kedron');
    expect(screen.getByRole('menuitem', { name: 'Link copied' })).toBeTruthy();
  });

  it('offers the share sheet as More options where the browser has one', async () => {
    const share = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, share });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'More options' }));
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:3000/s/kedron' }),
    );
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('returns focus to the pill after a channel is chosen', async () => {
    await renderPage();
    const pill = screen.getByRole('button', { name: 'Share' });
    fireEvent.click(pill);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Email' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  it('closes on an outside click', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('seller page tabs', () => {
  it('moves between Products, About and Certificates with the arrow keys', async () => {
    await renderPage();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Products (6)', 'About', 'Certificates']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'About' }));
    const panel = screen.getByRole('tabpanel', { name: 'About' });
    expect(within(panel).getByText('ABN checked by Mondapac')).toBeTruthy();
    expect(within(panel).getByText('Greater Brisbane')).toBeTruthy();
    expect(within(panel).getByText(/Seller contact details are not shown/)).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    const certs = screen.getByRole('tabpanel', { name: 'Certificates' });
    expect(within(certs).getByRole('heading', { name: 'Halal certificate' })).toBeTruthy();
    expect(within(certs).getByText('HC-2025-0142')).toBeTruthy();
    expect(within(certs).getByText('Approved and in date')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('tabpanel', { name: 'Products (6)' })).toBeTruthy();
  });

  it('explains that a seller without a certificate has no halal label', async () => {
    await renderPage('paddington');
    fireEvent.click(screen.getByRole('tab', { name: 'Certificates' }));
    expect(
      screen.getByText(
        'Paddington Bakehouse has no certificates shown. Products from this seller carry no halal label.',
      ),
    ).toBeTruthy();
  });
});

describe('seller products', () => {
  it('searches in the shop, and Clear search brings every product back', async () => {
    await renderPage();
    const search = screen.getByRole('searchbox', { name: 'Search in Kedron Halal Butchers' });
    fireEvent.change(search, { target: { value: 'LAMB' } });
    expect(count()).toBe('3 products');
    fireEvent.change(search, { target: { value: 'tofu' } });
    expect(count()).toBe('0 products');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(count()).toBe('6 products');
    expect(document.activeElement).toBe(search);
  });

  it('filters by category chip and sorts by price', async () => {
    await renderPage();
    const chips = screen.getByRole('group', { name: 'Category' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'Meat', 'Poultry']);
    fireEvent.click(within(chips).getByRole('button', { name: 'Poultry' }));
    expect(cardNames()).toEqual(['Free-range chicken, whole']);
    fireEvent.click(within(chips).getByRole('button', { name: 'Meat' }));
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'price-low' } });
    const names = cardNames();
    expect(names[0]).toBe('Beef sausages, 8 pack');
    expect(names[names.length - 1]).toBe('Beef brisket, 1 kg');
  });

  it('shows eight cards, then eight more with Show more', async () => {
    await renderPage('sunnybank');
    expect(cardNames()).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show more (1)' }));
    expect(cardNames()).toHaveLength(9);
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });

  it('has no category chips for a one-category seller, and an empty state with no products', async () => {
    await renderPage('paddington');
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull();
    cleanup();
    await renderPage('coorparoo');
    expect(screen.getByRole('heading', { name: 'No products yet' })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
