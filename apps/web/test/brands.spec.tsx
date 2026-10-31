// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { BrandLogo, monogramOf } from '../src/brands/brand-pictures.tsx';
import { BrandLoading, BrandPage } from '../src/brands/brand-page.tsx';
import { BrandsLoading, BrandsPage } from '../src/brands/brands-page.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { sampleBrandIndex, sampleBrandPage } from '../src/storefront/sample-brands.ts';
import type { Brand, BrandIndex, BrandPage as BrandPageData } from '../src/storefront/types.ts';

// The brand pages of design B5: the A to Z index and the brand page, with the monogram and the
// picture variants, the short list with "See all N", the full list with its pager, and every empty
// and failed state.

// The few DOM matchers these tests read best with (the project does not load jest-dom).
interface DomMatchers {
  toBeInTheDocument(): void;
  toHaveAttribute(name: string, value?: string): void;
  toHaveTextContent(text: string): void;
  toHaveClass(name: string): void;
}
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion extends DomMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends DomMatchers {}
}
expect.extend({
  toBeInTheDocument(received: Element | null) {
    const pass = received !== null && document.contains(received);
    return {
      pass,
      message: () => `expected the element ${pass ? 'not ' : ''}to be in the document`,
    };
  },
  toHaveAttribute(received: Element | null, name: string, value?: string) {
    const actual = received?.getAttribute(name) ?? null;
    const pass = value === undefined ? actual !== null : actual === value;
    return {
      pass,
      message: () =>
        `expected attribute ${name}${value === undefined ? '' : `=${value}`}, got ${String(actual)}`,
    };
  },
  toHaveTextContent(received: Element | null, text: string) {
    const actual = received?.textContent ?? '';
    return {
      pass: actual.includes(text),
      message: () => `expected text "${text}", got "${actual}"`,
    };
  },
  toHaveClass(received: Element | null, name: string) {
    const pass = received?.classList.contains(name) ?? false;
    return { pass, message: () => `expected class ${name} ${pass ? 'not ' : ''}on the element` };
  },
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

function renderIn(ui: ReactNode, locale = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <StoreProvider>{ui}</StoreProvider>
    </NextIntlClientProvider>,
  );
}

const IMAGE = { src: '/logos/saffron.png', width: 200, height: 200 };
const BRAND: Brand = {
  slug: 'saffron-co',
  name: 'Saffron & Co',
  summary: 'Family spice mill in Western Sydney since 1998.',
  originCountry: 'AU',
  productCount: 14,
};
const card = (n: number) => ({
  id: `p${n}`,
  name: `Product ${n}`,
  sellerName: 'Atlas Pantry',
  category: 'pantry',
  price: { amount: 850, currency: 'AUD' },
  certifications: [],
});
const ok = (count: number, page = 1, hasMore = false): BrandPageData['products'] => ({
  kind: 'ok',
  items: Array.from({ length: count }, (_, i) => card(i + 1)),
  page,
  hasMore,
});
const pageOf = (over: Partial<BrandPageData> = {}): BrandPageData => ({
  brand: BRAND,
  products: ok(8),
  all: false,
  ...over,
});

describe('the monogram', () => {
  it.each([
    ['Saffron & Co', 'SC'],
    ['Atlas', 'A'],
    ['7 Seas', '7S'],
    ['al-Barakah Foods Ltd', 'AL'],
    ['Östlich Küche', 'ÖK'],
    ['& - &', '?'],
  ])('%s is %s', (name, letters) => {
    expect(monogramOf(name)).toBe(letters);
  });
});

describe('the logo tile', () => {
  it('shows the monogram as decoration when the brand has no logo', () => {
    const { container } = renderIn(<BrandLogo name="Saffron & Co" size="lg" />);
    expect(container.querySelector('.br-mark.lg')).toHaveTextContent('SC');
    expect(container.querySelector('.br-mark')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the logo with the alt text the brand wrote', () => {
    renderIn(
      <BrandLogo
        name="Saffron & Co"
        logo={{ ...IMAGE, alt: 'Saffron & Co mill logo' }}
        size="sm"
      />,
    );
    const img = screen.getByRole('img', { name: 'Saffron & Co mill logo' });
    expect(img).toHaveAttribute('src', IMAGE.src);
    expect(img).toHaveAttribute('width', '200');
  });

  it('falls back to the monogram when the picture fails to load', () => {
    const { container } = renderIn(
      <BrandLogo name="Saffron & Co" logo={{ ...IMAGE, alt: 'Logo' }} size="sm" />,
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('.br-mark')).toHaveTextContent('SC');
  });
});

describe('the A to Z index', () => {
  const index: BrandIndex = {
    sections: [
      { letter: 'A', brands: [{ slug: 'acme-tea', name: 'Acme Tea' }] },
      {
        letter: 'S',
        brands: [
          {
            slug: 'saffron-co',
            name: 'Saffron & Co',
            logo: { ...IMAGE, alt: 'Saffron & Co logo' },
          },
          { slug: 'sumac', name: 'Sumac' },
        ],
      },
      { letter: '#', brands: [{ slug: '7-seas', name: '7 Seas' }] },
    ],
    truncated: false,
  };

  it('has one h1, a jump row of the letters present and one section per letter', () => {
    renderIn(<BrandsPage index={index} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Brands' })).toBeInTheDocument();
    const jump = screen.getByRole('navigation', { name: 'Jump to a letter' });
    const links = within(jump).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#brands-a',
      '#brands-s',
      '#brands-other',
    ]);
    expect(links.map((a) => a.textContent)).toEqual(['AA', 'SS', '#Other']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'A',
      'S',
      'Other',
    ]);
    expect(document.getElementById('brands-s')).toHaveAttribute('aria-labelledby', 'brands-s-h');
  });

  it('links each brand tile to its page, with the logo alt text or the monogram', () => {
    renderIn(<BrandsPage index={index} />);
    const saffron = screen.getByRole('link', { name: /Saffron & Co/ });
    expect(saffron).toHaveAttribute('href', '/brands/saffron-co');
    expect(within(saffron).getByRole('img', { name: 'Saffron & Co logo' })).toBeInTheDocument();
    const sumac = screen.getByRole('link', { name: /Sumac/ });
    expect(sumac).toHaveAttribute('href', '/brands/sumac');
    expect(sumac.querySelector('.br-mark')).toHaveTextContent('S');
    expect(screen.getByRole('link', { name: /7 Seas/ })).toHaveAttribute('href', '/brands/7-seas');
  });

  it('says when the list was cut', () => {
    renderIn(<BrandsPage index={{ ...index, truncated: true }} />);
    expect(screen.getByText(/first brands only/u)).toBeInTheDocument();
  });

  it('shows the empty state with a way on when there is no brand', () => {
    renderIn(<BrandsPage index={{ sections: [], truncated: false }} />);
    expect(screen.getByRole('heading', { level: 2, name: 'No brands yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse products' })).toBeInTheDocument();
  });

  it('renders the sample index and the loading state', () => {
    renderIn(<BrandsPage index={sampleBrandIndex()} />);
    expect(screen.getByRole('link', { name: /Saffron & Co/ })).toBeInTheDocument();
    cleanup();
    renderIn(<BrandsLoading title="Brands" label="Loading brands" />);
    expect(screen.getByRole('status', { name: 'Loading brands' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});

describe('the brand page', () => {
  it('shows the crumbs, the name as the h1, the summary, the country and the count', () => {
    renderIn(<BrandPage page={pageOf()} />);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(within(crumbs).getByRole('link', { name: 'Brands' })).toHaveAttribute('href', '/brands');
    expect(within(crumbs).getByText('Saffron & Co')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 1, name: 'Saffron & Co' })).toBeInTheDocument();
    expect(screen.getByText(BRAND.summary!)).toBeInTheDocument();
    expect(screen.getByText('Made in Australia')).toBeInTheDocument();
    expect(screen.getByText('14 products')).toBeInTheDocument();
  });

  it('names the country in the page language', () => {
    renderIn(<BrandPage page={pageOf()} />, 'de');
    expect(screen.getByText('Made in Australien')).toBeInTheDocument();
  });

  it('leaves out the summary and the country the brand does not have, and counts one product', () => {
    renderIn(
      <BrandPage
        page={pageOf({
          brand: { slug: 'plain', name: 'Plain', productCount: 1 },
          products: ok(1),
        })}
      />,
    );
    expect(screen.queryByText(/Made in/u)).toBeNull();
    expect(screen.getByText('1 product')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /See all/u })).toBeNull();
  });

  it('draws the header picture as decoration, or the neutral bar, and the logo with its alt', () => {
    const { container } = renderIn(
      <BrandPage
        page={pageOf({
          brand: {
            ...BRAND,
            header: { src: '/h.jpg', width: 800, height: 300 },
            logo: { ...IMAGE, alt: 'Saffron & Co logo' },
          },
        })}
      />,
    );
    expect(container.querySelector('.br-cover.has-image img')).toHaveAttribute('alt', '');
    expect(screen.getByRole('img', { name: 'Saffron & Co logo' })).toBeInTheDocument();
    cleanup();
    const bare = renderIn(<BrandPage page={pageOf()} />);
    expect(bare.container.querySelector('.br-cover')).not.toHaveClass('has-image');
    expect(bare.container.querySelector('.br-body .br-mark')).toHaveTextContent('SC');
  });

  it('lists the products of every seller with the seller name under each card', () => {
    renderIn(<BrandPage page={pageOf()} />);
    const section = screen.getByRole('region', { name: 'Products' });
    expect(within(section).getAllByRole('article')).toHaveLength(8);
    expect(within(section).getAllByText('Atlas Pantry')).toHaveLength(8);
    expect(within(section).getByRole('link', { name: 'Product 1' })).toHaveAttribute(
      'href',
      '/p/p1',
    );
  });

  it('ends the short list with "See all N" to the full list, and has no pager', () => {
    renderIn(<BrandPage page={pageOf({ products: ok(8, 1, true) })} />);
    expect(screen.getByRole('link', { name: 'See all 14' })).toHaveAttribute(
      'href',
      '/brands/saffron-co?all=1#brand-products',
    );
    expect(screen.queryByRole('navigation', { name: 'Pages of products' })).toBeNull();
  });

  it('shows the full list with a numbered pager, and a way back to the brand', () => {
    renderIn(<BrandPage page={pageOf({ all: true, products: ok(24, 2, true) })} />);
    expect(screen.getByRole('heading', { level: 2, name: 'All products' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /See all/u })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the brand' })).toHaveAttribute(
      'href',
      '/brands/saffron-co',
    );
    const pager = screen.getByRole('navigation', { name: 'Pages of products' });
    expect(within(pager).getByRole('link', { name: 'Previous page' })).toHaveAttribute(
      'href',
      '/brands/saffron-co?all=1#brand-products',
    );
    expect(within(pager).getByRole('link', { name: 'Page 2' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(pager).getByRole('link', { name: 'Next page' })).toHaveAttribute(
      'href',
      '/brands/saffron-co?all=1&page=3#brand-products',
    );
  });

  it('dims Previous on the first page and Next on the last, and has no pager for one page', () => {
    renderIn(<BrandPage page={pageOf({ all: true, products: ok(24, 1, true) })} />);
    let pager = screen.getByRole('navigation', { name: 'Pages of products' });
    expect(within(pager).getByLabelText('Previous page')).toHaveAttribute('aria-disabled', 'true');
    expect(within(pager).getByLabelText('Next page')).not.toHaveAttribute('aria-disabled');
    cleanup();
    renderIn(<BrandPage page={pageOf({ all: true, products: ok(5, 2, false) })} />);
    pager = screen.getByRole('navigation', { name: 'Pages of products' });
    expect(within(pager).getByLabelText('Next page')).toHaveAttribute('aria-disabled', 'true');
    cleanup();
    renderIn(<BrandPage page={pageOf({ all: true, products: ok(5, 1, false) })} />);
    expect(screen.queryByRole('navigation', { name: 'Pages of products' })).toBeNull();
  });

  it('says so when the brand has no live product, and when a page is past the end', () => {
    renderIn(
      <BrandPage page={pageOf({ brand: { ...BRAND, productCount: 0 }, products: ok(0) })} />,
    );
    expect(
      screen.getByRole('heading', { level: 3, name: 'No products from this brand right now' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Saffron & Co products appear here/u)).toBeInTheDocument();
    cleanup();
    renderIn(<BrandPage page={pageOf({ all: true, products: ok(0, 9) })} />);
    expect(
      screen.getByRole('heading', { level: 3, name: 'There are no more products' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the first page' })).toHaveAttribute(
      'href',
      '/brands/saffron-co?all=1#brand-products',
    );
  });

  it('keeps the header and says so, with a retry, when the products could not be read', () => {
    renderIn(<BrandPage page={pageOf({ products: { kind: 'failed', page: 1 } })} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Saffron & Co' })).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('We could not load the products')).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/brands/saffron-co',
    );
  });

  it('renders every sample brand without error, and the loading state', () => {
    for (const section of sampleBrandIndex().sections)
      for (const { slug } of section.brands) {
        const page = sampleBrandPage(slug, 1, 8, false)!;
        const { unmount } = renderIn(<BrandPage page={page} />);
        expect(
          screen.getByRole('heading', { level: 1, name: page.brand.name }),
        ).toBeInTheDocument();
        unmount();
      }
    renderIn(<BrandLoading label="Loading brand" />);
    expect(screen.getByRole('status', { name: 'Loading brand' })).toBeInTheDocument();
  });
});
