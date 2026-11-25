// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { formatInstant, known, PRODUCT_STATUSES } from './format.ts';
import { OfferDetail } from './offer-detail.tsx';
import { Pager } from './pager.tsx';
import { ProductDetail } from './product-detail.tsx';
import type { OfferView, ProductView } from './types.ts';
import { visibleNavItems } from '@mondapac/ui';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
  getTimeZone: () => Promise.resolve('UTC'),
}));

const ID = '0190a000-0000-7000-8000-0000000000a1';
const offer = (over: Partial<OfferView> = {}): OfferView => ({
  offerId: ID,
  productId: ID,
  product: { productCode: 'P00000001', typeCode: 'grocery', name: 'Olive oil 1L' },
  sellerSku: 'OIL-1L',
  conditionCode: 'new',
  description: { 'en-AU': 'Cold pressed.' },
  status: 'published',
  listed: true,
  offSaleCauses: [],
  handling: 'SEALED_ORIGINAL',
  attestationRecorded: true,
  submittedAt: '2026-10-02T00:00:00.000Z',
  firstPublishedAt: '2026-10-03T00:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  version: 3,
  ...over,
});
const detail = (over: Partial<ProductView> = {}): ProductView => ({
  productId: ID,
  productCode: 'P00000001',
  typeCode: 'grocery',
  familyCode: 'food',
  variantModel: 'single',
  status: 'published',
  pausedAt: null,
  variants: [
    { variantId: 'a', state: 'published', variantCode: 'P-000001-0a' },
    { variantId: 'b', state: 'retired', variantCode: 'P-000001-0b' },
  ],
  maxVariants: 20,
  sensitiveFields: ['images'],
  lastChangedAt: '2026-10-09T03:30:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  pendingSubmittedAt: null,
  form: { taxCategories: [], units: [], fields: [], categories: [] },
  workingCopy: { content: {}, lastSavedAt: '2026-10-09T03:00:00.000Z', baseRevisionId: null },
  published: {
    revisionId: 'r1',
    revisionNo: 2,
    submittedAt: '2026-10-05T00:00:00.000Z',
    authorKind: 'seller',
    sensitive: false,
    sensitiveReasons: [],
    content: {},
  },
  pending: null,
  ...over,
});

describe('seller catalog pages', () => {
  afterEach(cleanup);

  it('links to the next page only when the API returned a cursor', async () => {
    const { container, rerender } = render(await Pager({ basePath: '/products', nextAfterId: ID }));
    expect(screen.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      `/products?after=${ID}`,
    );
    rerender((await Pager({ basePath: '/products', nextAfterId: null })) ?? <></>);
    expect(container.textContent).toBe('');
  });

  it('shows a product with active variants and the published version', async () => {
    render(await ProductDetail({ product: detail() }));
    expect(screen.getByRole('heading', { name: 'P00000001' })).toBeTruthy();
    expect(screen.getByText('1 of 20')).toBeTruthy();
    expect(screen.getByText('Published version')).toBeTruthy();
    expect(screen.queryByText('Waiting for review')).toBeNull();
  });

  it('has no Edit link: the product page is the form for a seller who may edit', async () => {
    render(await ProductDetail({ product: detail(), canEdit: true }));
    expect(screen.queryByRole('link', { name: 'Edit product' })).toBeNull();
    expect(document.querySelector('a[href$="/edit"]')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to products' }).getAttribute('href')).toBe(
      '/products',
    );
  });

  it('flags a pending revision and a closer review', async () => {
    render(
      await ProductDetail({
        product: detail({
          pending: {
            revisionId: 'r2',
            revisionNo: 3,
            submittedAt: '2026-10-08T00:00:00.000Z',
            authorKind: 'seller',
            sensitive: true,
            sensitiveReasons: ['images'],
            content: {},
          },
        }),
      }),
    );
    expect(screen.getAllByText('Waiting for review').length).toBeGreaterThan(0);
    expect(screen.getByText('Needs a closer review')).toBeTruthy();
  });

  it('explains why an offer is off sale, in words', async () => {
    render(
      await OfferDetail({
        offer: offer({ listed: false, offSaleCauses: ['tag-suspended', 'brand-new-cause'] }),
      }),
    );
    expect(screen.getByText('A certification tag is suspended')).toBeTruthy();
    expect(screen.getByText('Unknown reason')).toBeTruthy();
    expect(screen.getByText('Sealed original')).toBeTruthy();
    expect(screen.getByText('Cold pressed.')).toBeTruthy();
  });

  it('puts Your offer, why it is off sale, then the sizes on one page, with no tab bar', async () => {
    render(
      await OfferDetail({
        offer: offer({ listed: false, offSaleCauses: ['tag-suspended'] }),
        sizes: <section aria-label="Sizes, prices and stock">sizes</section>,
      }),
    );
    const names = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(['Your offer', 'Why this offer is not on sale']);
    const offSale = screen.getByRole('heading', { name: 'Why this offer is not on sale' });
    const sizes = screen.getByRole('region', { name: 'Sizes, prices and stock' });
    expect(offSale.compareDocumentPosition(sizes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Offer sections' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to offers' }).getAttribute('href')).toBe(
      '/offers',
    );
  });

  it('renders a seller-written description as text, not markup', async () => {
    render(
      await OfferDetail({
        offer: offer({ description: { 'en-AU': '<img src=x onerror=alert(1)>' } }),
      }),
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('formats instants in UTC and survives bad input', () => {
    expect(formatInstant('2026-10-09T23:30:00.000Z', 'en-AU')).toContain('UTC');
    expect(formatInstant(null, 'en-AU')).toBe('-');
    expect(formatInstant('nope', 'en-AU')).toBe('-');
    expect(known('draft', PRODUCT_STATUSES)).toBe('draft');
    expect(known('x', PRODUCT_STATUSES)).toBe('unknown');
  });

  it('shows the catalog nav items only with the view permission', () => {
    const ids = (keys: string[]) => visibleNavItems(sellerNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('s_products');
    expect(ids(['catalog.own-product.view'])).toEqual(
      expect.arrayContaining(['s_products', 's_offers']),
    );
  });
});
