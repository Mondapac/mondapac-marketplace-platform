// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { OffersPage } from '../src/offers/offers-page.tsx';
import { OFFERS_PATH, offersOf } from '../src/storefront/offers.ts';
import type { ApiRead } from '../src/storefront/api.ts';
import { loadOffers } from '../src/storefront/source.ts';

// The Offers page: the checks on the specials answer, the read of source.ts with the API on (which
// route, failure is never an empty page) and the page's states.

const reads = vi.hoisted(() => ({
  answers: new Map<string, ApiRead<unknown>>(),
  paths: [] as string[],
}));

vi.mock('../src/storefront/api.ts', () => ({
  apiGet: (path: string) => {
    reads.paths.push(path);
    return Promise.resolve(reads.answers.get(path.split('?')[0]!) ?? { kind: 'failed' });
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve(Object.assign((code: string) => code, { has: () => true })),
  getLocale: () => Promise.resolve('en'),
}));
vi.mock('../src/storefront/photo-source.ts', () => ({ photoUrls: () => Promise.resolve(null) }));
vi.mock('../src/catalog/browse-crumb.tsx', () => ({
  BrowseCrumb: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock('../src/home/add-control.tsx', () => ({ AddControl: () => null }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/offers',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

afterEach(() => {
  cleanup();
  reads.answers.clear();
  reads.paths.length = 0;
});

const special = (n: number, over: Record<string, unknown> = {}) => ({
  offerId: `0199aaaa-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  productId: `0199aaaa-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`,
  sellerId: '0199aaaa-0000-7000-8000-000000000003',
  name: `Special ${n}`,
  shortText: null,
  categoryIds: [],
  primaryImage: null,
  price: { amount: '2290', currency: 'AUD' },
  regularPrice: { amount: '2490', currency: 'AUD' },
  specialEndsAt: '2026-12-30T00:00:00Z',
  ...over,
});

describe('offersOf', () => {
  it('makes a card of each special, with the was price and the special pill', () => {
    const page = offersOf(
      { items: [special(1), special(2, { regularPrice: null })] },
      new Map(),
      null,
    );
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    expect(page.items.map((c) => c.name)).toEqual(['Special 1', 'Special 2']);
    expect(page.items[0]!.wasPrice).toEqual({ amount: 2490, currency: 'AUD' });
    // The was-price rule withheld the regular price: still on special, no saving shown.
    expect(page.items[1]!.wasPrice).toBeUndefined();
    expect(page.items[1]!.onSpecial).toBe(true);
  });

  it('fails on an answer that is no shelf, and drops a malformed item', () => {
    expect(offersOf(null, new Map(), null)).toEqual({ kind: 'failed' });
    expect(offersOf({ items: 'x' }, new Map(), null)).toEqual({ kind: 'failed' });
    expect(offersOf({ items: [special(1), { name: 5 }] }, new Map(), null)).toMatchObject({
      kind: 'ok',
      items: [{ name: 'Special 1' }],
    });
  });
});

describe('loadOffers', () => {
  it('reads the specials route once at its largest size', async () => {
    reads.answers.set('search/specials', { kind: 'ok', body: { items: [special(1)] } });
    const page = await loadOffers();
    expect(reads.paths).toContain(OFFERS_PATH);
    expect(OFFERS_PATH).toBe('search/specials?limit=24');
    expect(page).toMatchObject({ kind: 'ok', items: [{ name: 'Special 1' }] });
  });

  it('is failed, not empty, when the read fails', async () => {
    expect(await loadOffers()).toEqual({ kind: 'failed' });
  });

  it('is an empty page when nothing is on special', async () => {
    reads.answers.set('search/specials', { kind: 'ok', body: { items: [] } });
    expect(await loadOffers()).toEqual({ kind: 'ok', items: [] });
  });
});

function show(page: Parameters<typeof OffersPage>[0]['page']) {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <OffersPage page={page} />
    </NextIntlClientProvider>,
  );
}

describe('OffersPage', () => {
  it('lists the specials under the heading with a count and a link to each product', () => {
    const page = offersOf({ items: [special(1), special(2)] }, new Map(), null);
    show(page);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Offers');
    expect(screen.getByText('2 products on special')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(within(screen.getAllByRole('article')[0]!).getByRole('link').textContent).toBe(
      'Special 1',
    );
  });

  it('says plainly when nothing is on special', () => {
    show({ kind: 'ok', items: [] });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'No special prices right now',
    );
  });

  it('says it could not load, with Try again, never "no offers"', () => {
    show({ kind: 'failed' });
    expect(screen.getByRole('alert').textContent).toContain('We could not load the offers');
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe('/offers');
    expect(screen.queryByText('No special prices right now')).toBeNull();
  });
});
