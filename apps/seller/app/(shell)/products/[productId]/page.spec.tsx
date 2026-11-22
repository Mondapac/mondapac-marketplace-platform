// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not-found');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));
vi.mock('../../../../src/server/seller-shell.tsx', () => ({
  SellerShell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({ marketName: 'AU' }) }));
vi.mock('../../../../src/catalog/edit-form.tsx', () => ({
  EditForm: ({
    product,
    photos,
  }: {
    product: { productId: string };
    photos: readonly unknown[] | null;
  }) => (
    <div>
      edit-form {product.productId} photos={photos === null ? 'unread' : String(photos.length)}
    </div>
  ),
}));
vi.mock('../../../../src/catalog/product-detail.tsx', () => ({
  ProductDetail: ({ canEdit }: { canEdit: boolean }) => <div>detail canEdit={String(canEdit)}</div>,
}));
vi.mock('../../../../src/catalog/catalog-states.tsx', () => ({
  catalogStateFor: (page: { kind: string }) =>
    Promise.resolve(page.kind === 'ok' ? null : <div>state {page.kind}</div>),
}));
const loadCatalogPage = vi.fn();
vi.mock('../../../../src/server/catalog-page.ts', () => ({
  isUuid: (value: string) => value.startsWith('0190'),
  loadCatalogPage: (...args: unknown[]): unknown => loadCatalogPage(...args),
}));

import ProductPage from './page.tsx';

const ID = '0190a000-0000-7000-8000-0000000000a1';
const params = Promise.resolve({ productId: ID });
const product = { productId: ID, variantModel: 'single', version: 1 };

function serve(permissionKeys: string[], failing: string | null = null) {
  loadCatalogPage.mockImplementation((path: string) => {
    if (failing !== null && path.endsWith(failing))
      return Promise.resolve({ kind: 'unavailable', session: { permissionKeys } });
    const body = path.endsWith('/options')
      ? { locales: { supported: ['en-AU'], default: 'en-AU' } }
      : path.endsWith('/images')
        ? { images: [] }
        : product;
    return Promise.resolve({ kind: 'ok', session: { permissionKeys, csrfToken: 'csrf' }, body });
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the product page (server)', () => {
  it('renders the form, not the detail, for a seller who may edit', async () => {
    serve(['catalog.own-product.view', 'catalog.own-product.edit']);
    render(await ProductPage({ params }));
    expect(screen.getByText(`edit-form ${ID} photos=0`)).toBeTruthy();
    expect(screen.queryByText(/^detail/)).toBeNull();
  });

  it('renders the read-only detail without edit for a view-only seller', async () => {
    serve(['catalog.own-product.view']);
    render(await ProductPage({ params }));
    expect(screen.getByText('detail canEdit=false')).toBeTruthy();
    expect(screen.queryByText(/edit-form/)).toBeNull();
    expect(loadCatalogPage).toHaveBeenCalledTimes(1);
  });

  it('keeps the form usable when the photo list cannot be read', async () => {
    serve(['catalog.own-product.view', 'catalog.own-product.edit'], '/images');
    render(await ProductPage({ params }));
    expect(screen.getByText(`edit-form ${ID} photos=unread`)).toBeTruthy();
  });

  it('shows the load state, not the form, when the form options cannot be read', async () => {
    serve(['catalog.own-product.view', 'catalog.own-product.edit'], '/options');
    render((await ProductPage({ params })) as ReactNode);
    expect(screen.getByText('state unavailable')).toBeTruthy();
    expect(screen.queryByText(/edit-form/)).toBeNull();
  });

  it('shows not found for a malformed id', async () => {
    await expect(ProductPage({ params: Promise.resolve({ productId: 'nope' }) })).rejects.toThrow(
      'not-found',
    );
  });
});
