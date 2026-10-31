// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { ProductPage } from '../src/product/product-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import {
  isProductId,
  productDetailOf,
  type ProductDetailBody,
} from '../src/storefront/product-detail.ts';

// The product page on the API's answer (`search/product-detail/:id`): what the API has is shown,
// what it does not have yet (delivery window, seller city, photos, specifications, badges,
// similar products) is left out rather than invented.

afterEach(cleanup);

const PRODUCT = '01990000-0000-7000-8000-000000000900';
const labels = {
  minimum: (amount: string) => `${amount} minimum order`,
  noMinimum: 'No minimum order',
};

const unit = (
  amount: string,
  stock: ProductDetailBody['offers'][number]['units'][number]['stock'] = {
    status: 'in-stock',
    onlyLeft: null,
  },
) => ({
  variantId: '01990000-0000-7000-8000-000000002001',
  label: null,
  price: { amount, currency: 'AUD' },
  taxInclusive: true,
  special: null,
  stock,
});

const body = (offers: ProductDetailBody['offers']): ProductDetailBody => ({
  productId: PRODUCT,
  name: 'Lamb shoulder',
  shortDescription: 'Bone in',
  description: 'Lamb shoulder from a Queensland farm.',
  categoryIds: ['01990000-0000-7000-8000-0000000000ca'],
  offers,
});

const TWO_SELLERS = body([
  {
    offerId: '01990000-0000-7000-8000-000000001001',
    sellerId: '01990000-0000-7000-8000-000000005001',
    seller: { storeName: 'Kedron Butchers', minimumOrder: { amount: '3000', currency: 'AUD' } },
    units: [unit('1890', { status: 'low', onlyLeft: 2 })],
  },
  {
    offerId: '01990000-0000-7000-8000-000000001002',
    sellerId: '01990000-0000-7000-8000-000000005002',
    seller: { storeName: 'Logan Road Meats', minimumOrder: null },
    units: [unit('2100')],
  },
]);

describe('product detail mapping', () => {
  it('takes only product ids to the API', () => {
    expect(isProductId(PRODUCT)).toBe(true);
    expect(isProductId('whole-chicken')).toBe(false);
  });

  it('maps offers, stock and minimum orders, and leaves out what the API has not', () => {
    const detail = productDetailOf(TWO_SELLERS, 'en', labels)!;
    expect(detail.offers.map((o) => [o.id, o.seller.name, o.price.amount])).toEqual([
      ['01990000-0000-7000-8000-000000001001', 'Kedron Butchers', 1890],
      ['01990000-0000-7000-8000-000000001002', 'Logan Road Meats', 2100],
    ]);
    expect(detail.offers[0].lowStock).toBe(2);
    expect(detail.offers[0].minimumOrder).toBe('A$30 minimum order');
    expect(detail.offers[0].variantId).toBe('01990000-0000-7000-8000-000000002001');
    expect(detail.offers[1]?.lowStock).toBeUndefined();
    expect(detail.offers[1]?.minimumOrder).toBe('No minimum order');
    expect(detail.offers[0].certifications).toEqual([]);
    expect(detail.photos).toEqual([]);
    expect(detail.specifications).toEqual([]);
    expect(detail.similar).toEqual([]);
  });

  it('makes an out-of-stock offer unbuyable and leaves out an unknown minimum', () => {
    const detail = productDetailOf(
      body([
        {
          offerId: '01990000-0000-7000-8000-000000001001',
          sellerId: '01990000-0000-7000-8000-000000005001',
          seller: { storeName: 'Kedron Butchers' },
          units: [unit('1890', { status: 'out', onlyLeft: null })],
        },
      ]),
      'en',
      labels,
    )!;
    expect(detail.offers[0].lowStock).toBe(0);
    expect(detail.offers[0].minimumOrder).toBeUndefined();
  });

  it('is no product when no offer has a seller name or a usable price', () => {
    expect(
      productDetailOf(
        body([
          {
            offerId: '01990000-0000-7000-8000-000000001001',
            sellerId: '01990000-0000-7000-8000-000000005001',
            seller: { storeName: null },
            units: [unit('1890')],
          },
          {
            offerId: '01990000-0000-7000-8000-000000001002',
            sellerId: '01990000-0000-7000-8000-000000005002',
            seller: { storeName: 'Logan Road Meats' },
            units: [unit('12.5')],
          },
        ]),
        'en',
        labels,
      ),
    ).toBeUndefined();
  });
});

describe('product page on API data', () => {
  it('shows the price, stock and minimum order, without delivery, city or photos', () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('min-width: 1000px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <ProductPage product={productDetailOf(TWO_SELLERS, 'en', labels)!} category={undefined} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    const box = screen.getByRole('complementary', { name: 'Buy options' });
    expect(within(box).getByText('A$18.90')).toBeTruthy();
    expect(within(box).getByText('Only 2 left')).toBeTruthy();
    expect(within(box).getAllByText('A$30 minimum order').length).toBeGreaterThan(0);
    expect(within(box).queryByText(/delivery/i)).toBeNull();
    expect(screen.queryByText(/selling since/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Similar products' })).toBeNull();
    const others = screen.getByRole('region', { name: 'Other sellers' });
    expect(within(others).getAllByText('No minimum order').length).toBeGreaterThan(0);
  });

  it('leaves out an empty Details section', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <ProductPage
            product={productDetailOf(
              { ...TWO_SELLERS, description: null, shortDescription: null },
              'en',
              labels,
            )!}
            category={undefined}
          />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('heading', { name: 'Details' })).toBeNull();
  });
});

// The brand of the product (the API's `brand`, untrusted): a link to its page under the title.
describe('the brand on the product page', () => {
  const renderPage = (extra: Partial<ProductDetailBody>) => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('min-width: 1000px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>
          <ProductPage
            product={productDetailOf({ ...TWO_SELLERS, ...extra }, 'en', labels)!}
            category={undefined}
          />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
  };

  it('links the brand name to its page, beside the seller line', () => {
    renderPage({ brand: { slug: 'kedron-farms', name: 'Kedron Farms' } });
    const link = screen.getByRole('link', { name: 'Kedron Farms' });
    expect(link.getAttribute('href')).toBe('/brands/kedron-farms');
    expect(link.closest('p')?.textContent).toBe('Brand: Kedron Farms');
    expect(screen.getByRole('link', { name: 'Kedron Butchers' })).toBeTruthy();
  });

  it('shows no brand line for a product without a brand or with a malformed one', () => {
    for (const brand of [undefined, null, { slug: 'Bad_Slug', name: 'x' }, { slug: 'ok-slug' }]) {
      renderPage({ brand });
      expect(screen.queryByText(/^Brand:/u)).toBeNull();
      cleanup();
    }
  });

  it('maps a valid brand reference of the answer', () => {
    expect(
      productDetailOf({ ...TWO_SELLERS, brand: { slug: 'a-1', name: 'A1' } }, 'en', labels)?.brand,
    ).toEqual({ slug: 'a-1', name: 'A1' });
  });
});

// Certification badges: the API's `badges` are untrusted input. Each is checked field by field and
// a malformed one is dropped whole; absent means none.
describe('certification badges from the API', () => {
  const GOOD = {
    typeCode: 'halal',
    typeName: 'Halal',
    basis: 'SELLER',
    sellerClaim: false,
    issuerName: 'Brisbane Islamic Council',
    validUntilLocalDate: '2027-03-01',
    verifiedWithIssuer: true,
  };
  const withBadges = (badges: unknown, offers = TWO_SELLERS.offers): ProductDetailBody => ({
    ...TWO_SELLERS,
    offers: offers.map((offer, index) => (index === 0 ? { ...offer, badges } : offer)),
  });
  const certificationsOf = (badges: unknown) =>
    productDetailOf(withBadges(badges), 'en', labels)!.offers[0].certifications;

  it('maps a valid badge: type is the code, label is the name, the rest is kept', () => {
    expect(certificationsOf([GOOD])).toEqual([
      {
        type: 'halal',
        label: 'Halal',
        basis: 'SELLER',
        sellerClaim: false,
        issuer: 'Brisbane Islamic Council',
        validUntil: '2027-03-01',
        verifiedWithIssuer: true,
      },
    ]);
  });

  it('accepts a type the page has no artwork for, and null issuer and date', () => {
    expect(
      certificationsOf([
        {
          ...GOOD,
          typeCode: 'kosher',
          typeName: 'Kosher',
          issuerName: null,
          validUntilLocalDate: null,
        },
      ]),
    ).toEqual([
      {
        type: 'kosher',
        label: 'Kosher',
        basis: 'SELLER',
        sellerClaim: false,
        verifiedWithIssuer: true,
      },
    ]);
  });

  it('has none when badges are absent, not a list, or empty', () => {
    expect(productDetailOf(TWO_SELLERS, 'en', labels)!.offers[0].certifications).toEqual([]);
    for (const badges of [undefined, null, 'halal', {}, 3, []]) {
      expect(certificationsOf(badges)).toEqual([]);
    }
  });

  it.each([
    ['a type code in the wrong shape', { typeCode: 'Halal Cert' }],
    ['a one-letter type code', { typeCode: 'h' }],
    ['a type code over 32 characters', { typeCode: `a${'b'.repeat(32)}` }],
    ['an empty type name', { typeName: '' }],
    ['a blank type name', { typeName: '   ' }],
    ['a type name over 200 characters', { typeName: 'x'.repeat(201) }],
    ['a type name that is not text', { typeName: 5 }],
    ['an unknown basis', { basis: 'ADMIN' }],
    ['a sellerClaim that is not a boolean', { sellerClaim: 'false' }],
    ['a verifiedWithIssuer that is missing', { verifiedWithIssuer: undefined }],
    ['an issuer name over 200 characters', { issuerName: 'x'.repeat(201) }],
    ['an issuer name that is not text', { issuerName: 7 }],
    ['an empty issuer name', { issuerName: '' }],
    ['a date in another format', { validUntilLocalDate: '01/03/2027' }],
    ['a date that is not a day', { validUntilLocalDate: '2027-02-30' }],
    ['a date with a time', { validUntilLocalDate: '2027-03-01T00:00:00Z' }],
    ['a date that is missing', { validUntilLocalDate: undefined }],
  ])('drops a badge with %s whole, and keeps the valid one beside it', (_label, patch) => {
    const other = { ...GOOD, typeCode: 'vegan', typeName: 'Vegan' };
    expect(certificationsOf([{ ...GOOD, ...patch }, other]).map((c) => c.type)).toEqual(['vegan']);
  });

  it('drops an entry that is not an object, and keeps one badge per type', () => {
    expect(
      certificationsOf([null, 'halal', 4, [], GOOD, { ...GOOD, typeName: 'Halal again' }]).map(
        (c) => c.label,
      ),
    ).toEqual(['Halal']);
  });

  it('keeps at most ten badges', () => {
    const many = Array.from({ length: 15 }, (_, n) => ({ ...GOOD, typeCode: `type-${n}` }));
    expect(certificationsOf(many)).toHaveLength(10);
  });

  it('does not carry fields the page has no use for (a certificate id, extra keys) into the badge', () => {
    const [badge] = certificationsOf([
      { ...GOOD, certificateId: 'cert-123', versionId: 'v-1', documentUrl: 'https://x.test/a.pdf' },
    ]);
    expect(Object.keys(badge!).sort()).toEqual([
      'basis',
      'issuer',
      'label',
      'sellerClaim',
      'type',
      'validUntil',
      'verifiedWithIssuer',
    ]);
    expect(JSON.stringify(badge)).not.toMatch(/cert-123|v-1|documentUrl|x\.test/);
  });

  it('sets the seller card line only for the seller basis and never for a seller claim', () => {
    const certificates = (badges: unknown[]) =>
      productDetailOf(withBadges(badges), 'en', labels)!.offers[0].seller.certificates;
    expect(certificates([GOOD])).toEqual([{ type: 'halal', name: 'Halal' }]);
    expect(certificates([{ ...GOOD, sellerClaim: true }])).toEqual([]);
    expect(certificates([{ ...GOOD, basis: 'MANUFACTURER' }])).toEqual([]);
    expect(certificates([{ ...GOOD, typeName: '' }])).toEqual([]);
  });

  describe('on the page', () => {
    const renderOffer = (badges: unknown, intl: { locale?: string; timeZone?: string } = {}) => {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('min-width: 1000px'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;
      return render(
        <NextIntlClientProvider
          locale={intl.locale ?? 'en'}
          messages={messages}
          timeZone={intl.timeZone ?? 'UTC'}
        >
          <StoreProvider>
            <ProductPage
              product={productDetailOf(withBadges(badges), 'en', labels)!}
              category={undefined}
            />
          </StoreProvider>
        </NextIntlClientProvider>,
      );
    };

    it('shows the certificate, its issuer and a date in the page language', () => {
      renderOffer([GOOD]);
      const section = screen.getByRole('heading', { name: 'Certificates' }).closest('section')!;
      expect(within(section).getByText('Halal')).toBeTruthy();
      expect(
        within(section).getByText(/Issued by Brisbane Islamic Council to Kedron Butchers/),
      ).toBeTruthy();
      expect(within(section).getByText('Valid until Mar 1, 2027')).toBeTruthy();
      expect(within(section).getByText('Confirmed with the issuer')).toBeTruthy();
      // The seal on the photo is for a certificate: it carries the type name.
      expect(screen.getAllByRole('img', { name: 'Halal' }).length).toBeGreaterThan(0);
    });

    it('words the issuer sentence first, then one meta line, and drops the review sentence when confirmed', () => {
      renderOffer([GOOD]);
      const section = screen.getByRole('heading', { name: 'Certificates' }).closest('section')!;
      expect(within(section).queryByText(/Our team checked/)).toBeNull();
      expect(within(section).queryByText('Reviewed by our team')).toBeNull();
      const meta = section.querySelector('.certmeta')!;
      expect(meta.textContent).toBe('Valid until Mar 1, 2027Confirmed with the issuer');
      expect(meta.querySelector('svg')).not.toBeNull();
    });

    it('keeps a short platform-reviewed line when the issuer did not confirm', () => {
      renderOffer([{ ...GOOD, verifiedWithIssuer: false }]);
      const section = screen.getByRole('heading', { name: 'Certificates' }).closest('section')!;
      expect(within(section).queryByText('Confirmed with the issuer')).toBeNull();
      expect(within(section).getByText('Reviewed by our team')).toBeTruthy();
      expect(section.querySelector('.certmeta svg')).toBeNull();
    });

    it("words a manufacturer's certificate as the maker's, with the seal and no declaration text", () => {
      renderOffer([{ ...GOOD, basis: 'MANUFACTURER' }]);
      const section = screen.getByRole('heading', { name: 'Certificates' }).closest('section')!;
      expect(
        within(section).getByText(
          'Issued by Brisbane Islamic Council to the maker of this product.',
        ),
      ).toBeTruthy();
      expect(within(section).queryByText(/Kedron Butchers/)).toBeNull();
      expect(within(section).queryByText(/seller's own declaration/)).toBeNull();
      expect(within(section).queryByText(/declares this themselves/)).toBeNull();
      // A certificate, so the seal is drawn in the box and on the photo.
      expect(section.querySelector('.certbox .cl svg')).not.toBeNull();
      expect(screen.getAllByRole('img', { name: 'Halal' }).length).toBeGreaterThan(0);
    });

    it("words a manufacturer's certificate without an issuer name", () => {
      renderOffer([{ ...GOOD, basis: 'MANUFACTURER', issuerName: null }]);
      expect(screen.getByText('Issued to the maker of this product.')).toBeTruthy();
    });

    it.each([
      ['2027-01-31', 'Pacific/Kiritimati', 'en', 'Valid until Jan 31, 2027'],
      ['2027-01-31', 'America/Los_Angeles', 'en', 'Valid until Jan 31, 2027'],
      ['2027-03-01', 'Pacific/Kiritimati', 'en', 'Valid until Mar 1, 2027'],
      ['2027-03-01', 'America/Los_Angeles', 'en', 'Valid until Mar 1, 2027'],
      ['2027-01-31', 'America/Los_Angeles', 'en-AU', 'Valid until 31 Jan 2027'],
      ['2027-03-01', 'Pacific/Kiritimati', 'en-AU', 'Valid until 1 Mar 2027'],
    ])(
      'shows the calendar date %s unshifted in zone %s and locale %s',
      (validUntilLocalDate, timeZone, locale, text) => {
        renderOffer([{ ...GOOD, validUntilLocalDate }], { locale, timeZone });
        expect(screen.getByText(text)).toBeTruthy();
      },
    );

    it("words a seller's own declaration as a declaration, with no seal", () => {
      renderOffer([{ ...GOOD, sellerClaim: true, issuerName: null, validUntilLocalDate: null }]);
      const section = screen.getByRole('heading', { name: 'Certificates' }).closest('section')!;
      expect(within(section).getByText("Halal (seller's own declaration)")).toBeTruthy();
      expect(
        within(section).getByText(
          /Kedron Butchers declares this themselves\. This is not a certificate/,
        ),
      ).toBeTruthy();
      expect(within(section).queryByText(/Issued/)).toBeNull();
      expect(screen.queryByRole('img', { name: 'Halal' })).toBeNull();
      expect(section.querySelector('.certbox .cl')).toBeNull();
      expect(section.querySelector('.certmeta')).toBeNull();
    });

    it("marks a seller's own declaration in the Other sellers row with a short, neutral chip", () => {
      const other = {
        ...TWO_SELLERS,
        offers: TWO_SELLERS.offers.map((offer, index) =>
          index === 1 ? { ...offer, badges: [{ ...GOOD, sellerClaim: true }] } : offer,
        ),
      };
      window.matchMedia = ((query: string) => ({
        matches: query.includes('min-width: 1000px'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;
      render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <StoreProvider>
            <ProductPage product={productDetailOf(other, 'en', labels)!} category={undefined} />
          </StoreProvider>
        </NextIntlClientProvider>,
      );
      const row = document.querySelector('#others')!;
      const chip = within(row as HTMLElement).getByText("Halal · seller's declaration");
      expect(chip.className).toBe('badge decl');
      expect(chip.className).not.toContain('hl');
    });

    it('shows no Certificates section when every badge is malformed', () => {
      renderOffer([{ ...GOOD, typeCode: 'NOPE' }]);
      expect(screen.queryByRole('heading', { name: 'Certificates' })).toBeNull();
    });
  });
});
