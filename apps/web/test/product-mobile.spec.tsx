// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { formatMoney } from '../src/format/money.ts';
import { ProductPage } from '../src/product/product-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { loadProduct } from '../src/storefront/source.ts';
import type { ProductDetail } from '../src/storefront/types.ts';

vi.mock('next/navigation', () => ({ usePathname: () => '/p/whole-chicken' }));

afterEach(cleanup);

const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');

function screenIs(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes('max-width: 699.98px'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => screenIs(true));

async function page(edit: (p: ProductDetail) => ProductDetail = (p) => p) {
  const found = await loadProduct('whole-chicken');
  if (!found) throw new Error('no sample product');
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <ProductPage product={edit(found)} category={undefined} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('gallery on a phone', () => {
  it('shows a labelled, polite count and follows the swipe', async () => {
    await page();
    const row = screen.getByRole('group', { name: 'Product photos' });
    expect(row.className).toBe('gtrack');
    expect(row.getAttribute('tabindex')).toBe('0');
    const count = document.querySelector('.gcount')!;
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(within(count as HTMLElement).getByText('1/4')).toBeTruthy();
    expect(count.textContent).toContain('Photo 1 of 4');
    Object.defineProperty(row, 'clientWidth', { value: 300, configurable: true });
    row.scrollLeft = 600;
    fireEvent.scroll(row);
    expect(count.textContent).toContain('Photo 3 of 4');
    expect(within(count as HTMLElement).getByText('3/4')).toBeTruthy();
    // Only the photo in view has a name.
    expect(screen.getAllByRole('img', { name: 'Free-range chicken, whole' })).toHaveLength(1);
  });

  it('has no count for a single photo', async () => {
    await page((p) => ({ ...p, photos: p.photos.slice(0, 1), photoThumbs: undefined }));
    expect(document.querySelector('.gcount')).toBeNull();
  });

  it('keeps the certification seal as the structured badge on the photo', async () => {
    await page();
    const photo = document.querySelector<HTMLElement>('.gmain')!;
    expect(within(photo).getByRole('img', { name: 'Halal certified' })).toBeTruthy();
  });
});

describe('collapsible Details and Specifications', () => {
  it('are buttons with aria-expanded and aria-controls on a phone, closed at first', async () => {
    await page();
    for (const name of ['Details', 'Specifications']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-expanded')).toBe('false');
      const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
      expect(panel.hidden).toBe(true);
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(panel.hidden).toBe(false);
      fireEvent.click(button);
      expect(panel.hidden).toBe(true);
    }
  });

  it('are plain headings with their content on a wider screen', async () => {
    screenIs(false);
    await page();
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Details' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Specifications' })).toBeTruthy();
    expect(screen.getByText('Weight').closest('[hidden]')).toBeNull();
  });

  it('are 44px tall and clamp nothing twice', () => {
    expect(css).toMatch(/\.acc-btn \{[^}]*min-block-size: 44px/);
    expect(css).toMatch(/\.acc\[data-mode='phone'\] \.dmore \{\s*display: none/);
  });
});

describe('buy bar', () => {
  it('turns Add to cart into the quantity stepper', async () => {
    await page();
    const bar = document.querySelector<HTMLElement>('.buybar')!;
    fireEvent.click(within(bar).getByRole('button', { name: 'Add to cart' }));
    const group = within(bar).getByRole('group', { name: 'Quantity' });
    expect(within(group).getByText('1')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Increase' }));
    expect(within(group).getByText('2')).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: 'Decrease' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Decrease' }));
    expect(within(bar).getByRole('button', { name: 'Add to cart' })).toBeTruthy();
  });

  it('has targets of at least 44px and hides while the keyboard is open', () => {
    expect(css).toMatch(/\.qstep button \{\s*width: 44px;\s*height: 44px/);
    expect(css).toMatch(/\.btn \{[^}]*min-height: 44px/);
    expect(css).toMatch(/:root\[data-keyboard='open'\] \.buybar \{\s*display: none/);
  });

  it('shows the price of each market in its own currency', async () => {
    for (const currency of ['AUD', 'JPY']) {
      cleanup();
      await page((p) => ({
        ...p,
        offers: p.offers.map((o, i) =>
          i === 0 ? { ...o, price: { amount: 2290, currency }, wasPrice: undefined } : o,
        ) as unknown as ProductDetail['offers'],
      }));
      const bar = document.querySelector<HTMLElement>('.buybar')!;
      const expected = formatMoney({ amount: 2290, currency }, 'en');
      expect(within(bar).getByText(expected)).toBeTruthy();
      expect(bar.textContent).toBe(expected + 'including GSTAdd to cart');
    }
    expect(formatMoney({ amount: 2290, currency: 'JPY' }, 'en')).not.toBe(
      formatMoney({ amount: 2290, currency: 'AUD' }, 'en'),
    );
  });
});

describe('inset rules in the sheet', () => {
  const block = (start: string) => {
    const at = css.indexOf(start);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', css.indexOf('}', at) + 1) + 1);
  };

  it('slides the tab bar by a transform and drops the buy bar to the edge, on a phone only', () => {
    const phone = css.slice(css.indexOf('/* Product page on a phone (M4)'));
    expect(phone).toMatch(
      /@media \(max-width: 699\.98px\) \{[\s\S]*data-tabbar='hidden'\] \.tabbar/,
    );
    expect(block(":root[data-tabbar='hidden'] .tabbar")).toContain('translateY(100%)');
    // The empty dock sits above the buy bar: taps must reach the bar through it.
    expect(block(":root[data-tabbar='hidden'] .dock")).toContain('pointer-events: none');
    expect(block(":root[data-tabbar='hidden'] .dock")).toContain('overflow: clip');
    expect(block(":root[data-tabbar='hidden'] .buybar")).toMatch(/bottom: calc\(14px \+/);
    // The buy bar takes the inset from --sf-dock-inset only; it has no padding of its own for it.
    expect(block(":root[data-tabbar='hidden'] .buybar")).toContain('var(--sf-dock-inset');
    expect(css).not.toMatch(/\n\s*\.buybar \{[^}]*safe-area-inset-bottom/);
  });

  it('animates only with motion allowed, and only the transform and the offsets', () => {
    const motion = css.slice(css.indexOf('(prefers-reduced-motion: no-preference) {\n  .tabbar {'));
    expect(motion).toContain('transform 200ms');
    expect(motion).toContain('bottom 200ms');
    expect(motion).not.toMatch(/transition:\s*(all|height|margin)/);
  });
});
