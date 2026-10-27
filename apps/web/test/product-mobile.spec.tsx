// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { formatMoney } from '../src/format/money.ts';
import { Collapsible } from '../src/product/collapsible.tsx';
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
    // Every photo is reachable by a screen reader, each with its place in the row.
    expect(row.querySelector('[aria-hidden]')).toBeNull();
    expect(
      within(row)
        .getAllByRole('img')
        .map((img) => img.getAttribute('alt')),
    ).toEqual([1, 2, 3, 4].map((n) => `Free-range chicken, whole, photo ${n} of 4`));
  });

  it('keeps the row out of the tab order on a wider screen', async () => {
    screenIs(false);
    await page();
    expect(screen.getByRole('group', { name: 'Product photos' }).hasAttribute('tabindex')).toBe(
      false,
    );
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
  const sections = () => Array.from(document.querySelectorAll<HTMLDetailsElement>('details.acc'));

  it('are native details with a summary, rendered open before any script runs', async () => {
    const view = await page();
    // The markup the server sends: open on every screen, so the content is there without JS.
    const { renderToString } = await import('react-dom/server');
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Collapsible title="Details" level="h2">
          <p>Body</p>
        </Collapsible>
      </NextIntlClientProvider>,
    );
    expect(html).toMatch(/<details[^>]* open=""[^>]*>/);
    expect(html).toContain('Body');
    view.unmount();
  });

  it('close on a phone, reopen by their summary and stay one heading each', async () => {
    await page();
    expect(sections().map((d) => d.querySelector('summary')!.textContent)).toEqual([
      'Details',
      'Specifications',
    ]);
    for (const details of sections()) {
      expect(details.open).toBe(false);
      details.open = true;
      expect(details.querySelector('summary h2, summary h3')).not.toBeNull();
      expect(details.open).toBe(true);
    }
  });

  it('are plain, open headings with their content on a wider screen, and cannot be closed', async () => {
    screenIs(false);
    await page();
    expect(screen.getByRole('heading', { level: 2, name: 'Details' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Specifications' })).toBeTruthy();
    for (const details of sections()) expect(details.open).toBe(true);
    expect(screen.getByText('Weight')).toBeTruthy();
  });

  it('have 44px summaries, no clamp twice, a start-aligned description, and no pointer on wide', () => {
    expect(css).toMatch(/\.acc-sum \{\s*min-block-size: 44px/);
    expect(css).toMatch(/\.acc \.dmore \{\s*display: none/);
    expect(css).toMatch(/\.desc \{\s*text-align: start/);
    expect(css).toMatch(/@media \(min-width: 700px\) \{\s*\.acc-sum \{\s*pointer-events: none/);
    // The count shows on a phone only.
    expect(css).toMatch(/\.acc-sum \.ico,\s*\.gcount \{\s*display: none/);
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
