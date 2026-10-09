// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { formatInstant, known, PRODUCT_STATUSES } from './format.ts';
import { OfferDetail } from './offer-detail.tsx';
import { OffersTable } from './offers-table.tsx';
import { Pager } from './pager.tsx';
import { ProductDetail } from './product-detail.tsx';
import { ProductsTable } from './products-table.tsx';
import type { OfferView, ProductListItem, ProductView } from './types.ts';
import { visibleNavItems } from '@mondapac/ui';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));

const ID = '0190a000-0000-7000-8000-0000000000a1';
const product = (over: Partial<ProductListItem> = {}): ProductListItem => ({
  productId: ID,
  productCode: 'P00000001',
  typeCode: 'grocery',
  status: 'published',
  draftName: 'Olive oil 1L',
  hasPublishedRevision: true,
  hasPendingRevision: false,
  pendingSubmittedAt: null,
  lastChangedAt: '2026-10-09T03:30:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
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
  status: 'published',
  variants: [
    { variantId: 'a', state: 'published' },
    { variantId: 'b', state: 'retired' },
  ],
  maxVariants: 20,
  sensitiveFields: ['images'],
  lastChangedAt: '2026-10-09T03:30:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  pendingSubmittedAt: null,
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

  it('lists products with status, pending flag and a detail link', async () => {
    render(
      await ProductsTable({
        items: [product(), product({ productId: 'x', status: 'draft', hasPendingRevision: true })],
      }),
    );
    expect(screen.getAllByRole('link', { name: 'Olive oil 1L' })[0]?.getAttribute('href')).toBe(
      `/products/${ID}`,
    );
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByText('Waiting for review')).toBeTruthy();
    expect(screen.getAllByText(/Oct 2026.*UTC/).length).toBeGreaterThan(0);
  });

  it('shows an empty state with no products', async () => {
    render(await ProductsTable({ items: [] }));
    expect(screen.getByText('No products yet')).toBeTruthy();
  });

  it('shows an unknown status as Unknown instead of a raw value', async () => {
    render(await ProductsTable({ items: [product({ status: 'mystery' })] }));
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('lists offers with sku, status and on-sale state', async () => {
    render(
      await OffersTable({
        items: [
          offer(),
          offer({ offerId: 'y', status: 'changes-needed', listed: false, submittedAt: null }),
        ],
      }),
    );
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]!).getByText('On sale')).toBeTruthy();
    expect(within(rows[2]!).getByText('Changes needed')).toBeTruthy();
    expect(within(rows[2]!).getByText('Not on sale')).toBeTruthy();
  });

  it('shows an empty state with no offers', async () => {
    render(await OffersTable({ items: [] }));
    expect(screen.getByText('No offers yet')).toBeTruthy();
  });

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
    expect(formatInstant('2026-10-09T23:30:00.000Z')).toContain('UTC');
    expect(formatInstant(null)).toBe('-');
    expect(formatInstant('nope')).toBe('-');
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
