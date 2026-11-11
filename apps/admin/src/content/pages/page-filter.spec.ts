import { describe, expect, it } from 'vitest';
import { NO_PAGE_FILTERS, filterPages } from './page-filter.ts';
import { listedPages, pageRef, type PageSummary } from './page-types.ts';

const page = (patch: Partial<PageSummary>): PageSummary => ({
  id: null,
  kind: 'system',
  systemKey: 'home',
  slug: null,
  path: '/',
  templateKey: 'system.home',
  title: 'Home',
  editLevel: 'full',
  status: 'default',
  hasDraft: false,
  publishedVersionNo: null,
  publishedAt: null,
  updatedAt: null,
  ...patch,
});

const pages = [
  page({}),
  page({ systemKey: 'cart', path: '/cart', title: 'Cart', editLevel: 'limited' }),
  page({
    id: 'p1',
    kind: 'dynamic',
    systemKey: null,
    slug: 'ramadan',
    path: '/l/ramadan',
    templateKey: 'campaign-landing',
    title: 'Ramadan specials',
    status: 'published',
  }),
  page({
    id: 'p2',
    kind: 'dynamic',
    systemKey: null,
    slug: 'eid',
    path: '/l/eid',
    templateKey: 'info-page',
    title: 'Eid hours',
    status: 'draft',
  }),
  page({ systemKey: 'navigation', title: 'Navigation', editLevel: 'navigation' }),
];

describe('listedPages', () => {
  it('leaves the navigation to its own tab', () => {
    expect(listedPages(pages).map((entry) => entry.title)).toEqual([
      'Home',
      'Cart',
      'Ramadan specials',
      'Eid hours',
    ]);
  });
});

describe('pageRef', () => {
  it('is the id of a saved page and the key of an unchanged system page', () => {
    expect(pageRef(pages[2]!)).toBe('p1');
    expect(pageRef(pages[0]!)).toBe('home');
  });
});

describe('filterPages', () => {
  const titles = (filters: Parameters<typeof filterPages>[1]) =>
    filterPages(listedPages(pages), filters).map((entry) => entry.title);

  it('shows every page without filters', () => {
    expect(titles(NO_PAGE_FILTERS)).toHaveLength(4);
  });

  it('filters by type', () => {
    expect(titles({ ...NO_PAGE_FILTERS, kind: 'dynamic' })).toEqual([
      'Ramadan specials',
      'Eid hours',
    ]);
    expect(titles({ ...NO_PAGE_FILTERS, kind: 'system' })).toEqual(['Home', 'Cart']);
  });

  it('filters by status', () => {
    expect(titles({ ...NO_PAGE_FILTERS, status: 'draft' })).toEqual(['Eid hours']);
  });

  it('searches the title and the address, ignoring case', () => {
    expect(titles({ ...NO_PAGE_FILTERS, search: ' RAMADAN ' })).toEqual(['Ramadan specials']);
    expect(titles({ ...NO_PAGE_FILTERS, search: '/l/eid' })).toEqual(['Eid hours']);
  });

  it('combines the filters', () => {
    expect(titles({ kind: 'dynamic', status: 'published', search: 'eid' })).toEqual([]);
  });
});
