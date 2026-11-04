// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { ProductPage } from '../src/product/product-page.tsx';
import { productStructuredData } from '../src/seo/structured-data.ts';
import { StoreProvider } from '../src/shell/store-context.tsx';
import {
  productDetailOf,
  variantFromParam,
  type ProductDetailBody,
} from '../src/storefront/product-detail.ts';
import { defaultVariantOf } from '../src/storefront/variants.ts';

// The Variant picker of the product page: the default choice, out of stock, the `?v=` link, the
// swap of price and sellers, the keyboard, and the markup (ProductGroup, canonical).

afterEach(cleanup);

const PRODUCT = '01990000-0000-7000-8000-000000000900';
const V1 = '01990000-0000-7000-8000-000000002001';
const V5 = '01990000-0000-7000-8000-000000002005';
const V10 = '01990000-0000-7000-8000-000000002010';
const labels = { minimum: (a: string) => `${a} minimum`, noMinimum: 'No minimum' };

type Stock = ProductDetailBody['offers'][number]['units'][number]['stock'];
const IN: Stock = { status: 'in-stock', onlyLeft: null };
const OUT: Stock = { status: 'out', onlyLeft: null };

const unit = (variantId: string, label: string | null, amount: string, stock: Stock = IN) => ({
  variantId,
  label,
  price: { amount, currency: 'AUD' },
  taxInclusive: true,
  special: null,
  stock,
});

const seller = (n: number, name: string, units: ReturnType<typeof unit>[]) => ({
  offerId: `01990000-0000-7000-8000-00000000100${n}`,
  sellerId: `01990000-0000-7000-8000-00000000500${n}`,
  seller: { storeName: name },
  units,
});

const body = (offers: ProductDetailBody['offers']): ProductDetailBody => ({
  productId: PRODUCT,
  name: 'Basmati rice',
  shortDescription: null,
  description: null,
  categoryIds: ['01990000-0000-7000-8000-0000000000ca'],
  offers,
});

// Kedron sells 1 kg and 5 kg; Logan sells 5 kg cheaper, and a 10 kg bag nobody has in stock.
const RICE = body([
  seller(1, 'Kedron Grocers', [
    unit(V1, '1 kg', '900'),
    unit(V5, '5 kg', '3900'),
    unit(V10, '10 kg', '7000', OUT),
  ]),
  seller(2, 'Logan Pantry', [unit(V5, '5 kg', '3500'), unit(V10, '10 kg', '6800', OUT)]),
]);

describe('Variants from the API answer', () => {
  it('groups the offers by Variant in the owner order, lowest price first', () => {
    const detail = productDetailOf(RICE, 'en', labels)!;
    expect(detail.variants?.map((v) => [v.label, v.inStock])).toEqual([
      ['1 kg', true],
      ['5 kg', true],
      ['10 kg', false],
    ]);
    expect(detail.variants?.[1]?.offers.map((o) => [o.seller.name, o.price.amount])).toEqual([
      ['Logan Pantry', 3500],
      ['Kedron Grocers', 3900],
    ]);
  });

  it('lists a seller with stock before a cheaper one that is out, so the buy box can be bought', () => {
    const detail = productDetailOf(
      body([
        seller(1, 'Kedron Grocers', [unit(V1, '1 kg', '900'), unit(V5, '5 kg', '3000', OUT)]),
        seller(2, 'Logan Pantry', [unit(V5, '5 kg', '3500')]),
      ]),
      'en',
      labels,
    )!;
    const five = detail.variants!.find((v) => v.id === V5)!;
    expect(five.offers.map((o) => o.seller.name)).toEqual(['Logan Pantry', 'Kedron Grocers']);
    expect(five.offers[0].lowStock).toBeUndefined();
    const node = productStructuredData(
      detail,
      'https://shop.example',
      'https://shop.example/p/r',
    ) as unknown as {
      hasVariant: { offers: { availability: string } }[];
    };
    expect(node.hasVariant[1]!.offers.availability.endsWith('InStock')).toBe(true);
  });

  it('opens on the first Variant in stock, or on the first when none is', () => {
    const detail = productDetailOf(
      body([seller(1, 'Kedron Grocers', [unit(V1, '1 kg', '900', OUT), unit(V5, '5 kg', '3900')])]),
      'en',
      labels,
    )!;
    expect(detail.offers[0].variantId).toBe(V5);
    const none = productDetailOf(
      body([
        seller(1, 'Kedron Grocers', [unit(V1, '1 kg', '900', OUT), unit(V5, '5 kg', '3900', OUT)]),
      ]),
      'en',
      labels,
    )!;
    expect(defaultVariantOf(none.variants!).label).toBe('1 kg');
    expect(none.offers[0].variantId).toBe(V1);
  });

  it('has no Variants for a product with one, and keeps the featured offer first', () => {
    const detail = productDetailOf(
      body([
        seller(1, 'Kedron Grocers', [unit(V1, '1 kg', '900')]),
        seller(2, 'Logan Pantry', [unit(V1, '1 kg', '800')]),
      ]),
      'en',
      labels,
    )!;
    expect(detail.variants).toBeUndefined();
    expect(detail.offers.map((o) => o.seller.name)).toEqual(['Kedron Grocers', 'Logan Pantry']);
  });

  it('reads ?v= only when it names one of the Variants', () => {
    const detail = productDetailOf(RICE, 'en', labels)!;
    expect(variantFromParam(detail, V5.toUpperCase())).toBe(V5);
    expect(variantFromParam(detail, 'nope')).toBeUndefined();
    expect(variantFromParam(detail, [V5, V1])).toBeUndefined();
    expect(variantFromParam(detail, undefined)).toBeUndefined();
  });
});

function renderPage(initialVariantId?: string) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width: 1000px'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        <ProductPage
          product={productDetailOf(RICE, 'en', labels)!}
          category={undefined}
          initialVariantId={initialVariantId}
        />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

describe('the picker on the page', () => {
  beforeEach(() => window.history.replaceState(null, '', '/p/rice'));

  const box = () => screen.getByRole('complementary', { name: 'Buy options' });

  it('is a radio group opening on the default Variant, and shows no picker for one Variant', () => {
    renderPage();
    const group = within(box()).getByRole('radiogroup', { name: 'Choose an option' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(within(box()).getByText('A$9.00')).toBeTruthy();
    cleanup();
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <ProductPage
            product={productDetailOf(
              body([seller(1, 'Kedron Grocers', [unit(V1, '1 kg', '900')])]),
              'en',
              labels,
            )!}
            category={undefined}
          />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('opens on the Variant of ?v=', () => {
    renderPage(V5);
    expect(within(box()).getByRole('radio', { name: '5 kg' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(within(box()).getByText('A$35.00')).toBeTruthy();
  });

  it('swaps price, sellers and the bar, and writes ?v= without a reload', () => {
    renderPage();
    fireEvent.click(within(box()).getByRole('radio', { name: '5 kg' }));
    expect(within(box()).getByText('A$35.00')).toBeTruthy();
    // Only the sellers that sell 5 kg, lowest price first: Logan is the buy box's seller.
    expect(within(box()).getAllByText('Logan Pantry').length).toBeGreaterThan(0);
    const others = screen.getByRole('region', { name: 'Other sellers' });
    expect(within(others).getAllByText('Kedron Grocers').length).toBeGreaterThan(0);
    expect(within(others).getByText('A$39.00')).toBeTruthy();
    expect(window.location.search).toBe(`?v=${V5}`);
    // The sticky bar names the choice.
    expect(document.querySelector('.buybar small')?.textContent).toBe('5 kg · including GST');
    // 1 kg is sold by Kedron only: no Other sellers section.
    fireEvent.click(within(box()).getByRole('radio', { name: '1 kg' }));
    expect(screen.queryByRole('region', { name: 'Other sellers' })).toBeNull();
  });

  it('greys an out-of-stock Variant, says so and does not choose it', () => {
    renderPage();
    const tenKg = within(box()).getByRole('radio', { name: /10 kg/ });
    expect(tenKg.getAttribute('aria-disabled')).toBe('true');
    expect(within(tenKg).getByText('Out of stock')).toBeTruthy();
    fireEvent.click(tenKg);
    expect(within(box()).getByText('A$9.00')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('keeps an out-of-stock Variant chosen by the link and turns Add to cart off', () => {
    renderPage(V10);
    expect(within(box()).getByRole('radio', { name: /10 kg/ }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(
      within(box()).getByRole('button', { name: 'Out of stock' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('moves with the arrow keys over the Variants that can be chosen', () => {
    renderPage();
    const group = within(box()).getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(within(box()).getByRole('radio', { name: '5 kg' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    // 10 kg is out: the next one wraps to 1 kg.
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(within(box()).getByRole('radio', { name: '1 kg' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(within(box()).getByRole('radio', { name: '5 kg' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });
});

describe('structured data for Variants', () => {
  const ORIGIN = 'https://shop.example';
  const URL_ = `${ORIGIN}/p/rice`;

  it('is a ProductGroup with a Product per Variant, each with its own link and best offer', () => {
    const node = productStructuredData(
      productDetailOf(RICE, 'en', labels)!,
      ORIGIN,
      URL_,
    ) as Record<string, unknown>;
    expect(node['@type']).toBe('ProductGroup');
    expect(node.variesBy).toEqual(['https://schema.org/size']);
    const has = node.hasVariant as Record<string, unknown>[];
    expect(has.map((v) => v.name)).toEqual([
      'Basmati rice - 1 kg',
      'Basmati rice - 5 kg',
      'Basmati rice - 10 kg',
    ]);
    const five = has[1]!.offers as Record<string, unknown>;
    expect(five.url).toBe(`${URL_}?v=${V5}`);
    expect(five.price).toBe('35.00');
    expect(
      ((has[2]!.offers as Record<string, unknown>).availability as string).endsWith('OutOfStock'),
    ).toBe(true);
  });

  it('stays a Product with one Offer for a product with one Variant', () => {
    const node = productStructuredData(
      productDetailOf(
        body([seller(1, 'Kedron Grocers', [unit(V1, '1 kg', '900')])]),
        'en',
        labels,
      )!,
      ORIGIN,
      URL_,
    ) as Record<string, unknown>;
    expect(node['@type']).toBe('Product');
  });
});
