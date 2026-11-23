import { describe, expect, it } from 'vitest';
import { bestRoute, resolveHelp, routeScore, type HelpRegistry } from './help-resolve.ts';

const registry: HelpRegistry = {
  pages: [
    { route: '/sellers', slug: 'sellers' },
    { route: '/sellers/[sellerId]', slug: 'seller' },
    { route: '/sellers/needs-a-look', slug: 'needs' },
  ],
  tabbed: [
    {
      slug: 'cert',
      routes: ['/certificates', '/certificates/issuers'],
      tabs: [
        { label: 'Review queue', route: '/certificates' },
        { label: 'Issuers', route: '/certificates/issuers' },
      ],
    },
    {
      slug: 'brands',
      routes: ['/catalog/brands'],
      tabs: [{ label: 'Brands' }, { label: 'Duplicates' }],
    },
  ],
};

const text = {
  page: (slug: string) =>
    slug === 'sellers'
      ? {
          title: 'Sellers',
          about: 'All sellers.',
          good: ['Times are in {zone}.'],
          related: [{ label: 'Orders', href: '/orders' }],
        }
      : slug === 'seller'
        ? { title: 'Seller application', about: 'One seller.', good: [], related: [] }
        : slug === 'needs'
          ? { title: 'Needs a look', about: 'Sellers to check.', good: [], related: [] }
          : undefined,
  tabbed: (slug: string) =>
    slug === 'cert'
      ? {
          page: 'Certification',
          about: 'Certificates.',
          good: [],
          tabs: [
            {
              label: 'Review queue',
              text: 'Waiting certificates.',
              points: ['Oldest first.'],
              related: [
                { label: 'Issuers', href: '/certificates/issuers' },
                { label: 'Orders', href: '/orders' },
              ],
            },
            { label: 'Issuers', text: 'Issuing bodies.', points: [], related: [] },
          ],
        }
      : slug === 'brands'
        ? {
            page: 'Brands',
            about: 'Brand list.',
            good: [],
            related: [
              { label: 'Products', href: '/catalog/products' },
              { label: 'Brands', href: '/catalog/brands' },
            ],
            tabs: [
              { label: 'Brands', text: 'The brands.', points: [], related: [] },
              {
                label: 'Duplicates',
                text: 'Possible duplicates.',
                points: [],
                related: [
                  { label: 'Products', href: '/catalog/products' },
                  { label: 'Attributes', href: '/catalog/attributes' },
                ],
              },
            ],
          }
        : undefined,
};

const resolve = (pathname: string, activeTab?: string) =>
  resolveHelp({ pathname, registry, text, zone: 'Australia/Brisbane', activeTab });

describe('routeScore and bestRoute', () => {
  it('matches dynamic segments and prefers static ones', () => {
    expect(routeScore('/sellers/[sellerId]', '/sellers/abc')).toBe(1);
    expect(routeScore('/sellers/needs-a-look', '/sellers/abc')).toBe(-1);
    expect(
      bestRoute(['/sellers/[sellerId]', '/sellers/needs-a-look'], '/sellers/needs-a-look'),
    ).toBe('/sellers/needs-a-look');
    expect(routeScore('/sellers', '/sellers/abc')).toBe(-1);
  });
});

describe('resolveHelp', () => {
  it('fills the zone into the page lines', () => {
    expect(resolve('/sellers')?.goodToKnow).toEqual(['Times are in Australia/Brisbane.']);
  });

  it('gives a detail page its own text', () => {
    expect(resolve('/sellers/abc')?.page).toBe('Seller application');
    expect(resolve('/sellers/needs-a-look')?.page).toBe('Needs a look');
  });

  it('shows only the open tab of a tabbed page with route tabs, without links to its own tabs', () => {
    const queue = resolve('/certificates');
    expect(queue?.page).toBe('Certification');
    expect(queue?.tab).toEqual({
      name: 'Review queue',
      text: 'Waiting certificates.',
      points: ['Oldest first.'],
    });
    expect(queue?.related).toEqual([{ label: 'Orders', href: '/orders' }]);
    expect(resolve('/certificates/issuers')?.tab?.name).toBe('Issuers');
  });

  it('uses the marked tab when the tabs have no route', () => {
    expect(resolve('/catalog/brands', 'Duplicates')?.tab?.text).toBe('Possible duplicates.');
    expect(resolve('/catalog/brands')?.tab).toBeUndefined();
  });

  it("merges the page's Related with the open tab's, once each and never to the page itself", () => {
    expect(resolve('/catalog/brands')?.related).toEqual([
      { label: 'Products', href: '/catalog/products' },
    ]);
    expect(resolve('/catalog/brands', 'Duplicates')?.related).toEqual([
      { label: 'Products', href: '/catalog/products' },
      { label: 'Attributes', href: '/catalog/attributes' },
    ]);
  });

  it('returns null for an unknown path or missing text', () => {
    expect(resolve('/nowhere')).toBeNull();
    const missing = resolveHelp({
      pathname: '/sellers',
      registry,
      text: { page: () => undefined, tabbed: () => undefined },
      zone: 'UTC',
    });
    expect(missing).toBeNull();
  });
});
