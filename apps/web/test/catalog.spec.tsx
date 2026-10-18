// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';
import messages from '../messages/en.json';
import { FilterChips } from '../src/catalog/filter-chips.tsx';
import { Crumbs, EmptyResults, ProductResults } from '../src/catalog/results.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { findProducts, pageOf, queryOf } from '../src/storefront/catalog.ts';
import { SAMPLE_PRODUCTS, SAMPLE_SUBCATEGORY } from '../src/storefront/sample-catalog.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';

afterEach(cleanup);

const withIntl = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{node}</StoreProvider>
    </NextIntlClientProvider>,
  );

describe('product source of the results pages', () => {
  it('lists a category and a subcategory', async () => {
    const meat = await findProducts({ category: 'meat', page: 1 });
    expect(meat.items.map((p) => p.id)).toEqual([
      'lamb-shoulder',
      'brisket',
      'lamb-mince',
      'beef-sausages',
      'lamb-cutlets',
    ]);
    const lamb = await findProducts({ category: 'meat', subcategory: 'lamb', page: 1 });
    expect(lamb.items.map((p) => p.id)).toEqual(['lamb-shoulder', 'lamb-cutlets']);
  });

  it('matches every search word in the name, seller or category', async () => {
    const result = await findProducts({ q: 'lamb shoulder', page: 1 });
    expect(result.items.map((p) => p.id)).toEqual(['lamb-shoulder']);
    const bySeller = await findProducts({ q: 'kedron lamb', page: 1 });
    expect(bySeller.items.map((p) => p.id)).toEqual([
      'lamb-shoulder',
      'lamb-mince',
      'lamb-cutlets',
    ]);
    const none = await findProducts({ q: 'durian', page: 1 });
    expect(none.items).toEqual([]);
    expect(none.hasMore).toBe(false);
  });

  it('pages by the page size and says when a later page has items', async () => {
    const first = await findProducts({ category: 'produce', page: 1, pageSize: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.hasMore).toBe(true);
    const second = await findProducts({ category: 'produce', page: 2, pageSize: 4 });
    expect(second.hasMore).toBe(false);
    expect(second.items.map((p) => p.id)).not.toContain(first.items[0]!.id);
  });

  it('reads page and query values the way the API accepts them', () => {
    expect(pageOf(undefined)).toBe(1);
    expect(pageOf('3')).toBe(3);
    expect(pageOf(['2', '5'])).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'abc', '101', '0010000']) expect(pageOf(bad)).toBe(1);
    expect(queryOf('  basmati   rice ')).toBe('basmati rice');
    expect(Array.from(queryOf('x'.repeat(150)))).toHaveLength(100);
  });

  it('maps sample products only to subcategories of the sample tree', () => {
    for (const [id, sub] of Object.entries(SAMPLE_SUBCATEGORY)) {
      const product = SAMPLE_PRODUCTS.find((p) => p.id === id);
      expect(product, id).toBeDefined();
      const category = SAMPLE_CONTENT.categories.find((c) => c.code === product!.category)!;
      expect(
        category.children.map((c) => c.code),
        id,
      ).toContain(sub);
    }
  });
});

describe('results page parts', () => {
  it('shows the trail with the current page last and unlinked', () => {
    withIntl(
      <Crumbs
        trail={[
          { label: 'Home', href: '/' },
          { label: 'Meat', href: '/c/meat' },
        ]}
        current="Lamb"
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'Meat']);
    expect(within(nav).getByText('Lamb').getAttribute('aria-current')).toBe('page');
  });

  it('opens the Browse panel from the "Browse products" step of the trail', () => {
    withIntl(
      <Crumbs
        trail={[
          { label: 'Home', href: '/' },
          { label: 'Browse products', browse: true },
        ]}
        current="Meat"
      />,
    );
    const step = screen.getByRole('button', { name: 'Browse products' });
    expect(step.getAttribute('aria-controls')).toBe('browse-panel');
    expect(step.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('marks the chosen filter chip as current', () => {
    withIntl(
      <FilterChips
        label="Filter Meat"
        chips={[
          { label: 'All', href: '/c/meat', current: false },
          { label: 'Lamb', href: '/c/meat/lamb', current: true },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Filter Meat' });
    expect(within(nav).getByRole('link', { name: 'Lamb' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'All' }).hasAttribute('aria-current')).toBe(false);
  });

  it('shows the cards and a pager with the previous and the next page', async () => {
    const result = await findProducts({ category: 'produce', page: 2, pageSize: 2 });
    withIntl(
      <ProductResults result={result} hrefFor={(p) => `/c/produce?page=${p}`} empty={null} />,
    );
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 2, name: 'Products' })).toBeTruthy();
    const pager = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pager).getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe(
      '/c/produce?page=1',
    );
    expect(within(pager).getByRole('link', { name: 'Next' }).getAttribute('href')).toBe(
      '/c/produce?page=3',
    );
    expect(within(pager).getByText('Page 2')).toBeTruthy();
  });

  it('has no pager when everything fits on one page', async () => {
    const result = await findProducts({ category: 'meat', page: 1 });
    withIntl(<ProductResults result={result} hrefFor={() => '/c/meat'} empty={null} />);
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
  });

  it('shows the empty state, and a way back from a page past the last one', async () => {
    const none = await findProducts({ q: 'durian', page: 1 });
    withIntl(
      <ProductResults
        result={none}
        hrefFor={() => '/search?q=durian'}
        empty={<EmptyResults message="No products match “durian”." />}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('No products match “durian”.');
    cleanup();
    const past = await findProducts({ category: 'meat', page: 5 });
    withIntl(<ProductResults result={past} hrefFor={() => '/c/meat'} empty={null} />);
    expect(screen.getByRole('link', { name: 'Go to the first page' }).getAttribute('href')).toBe(
      '/c/meat',
    );
  });
});
