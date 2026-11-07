// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../../../messages/en.json';
import type { AdminSession } from '../../../../../../../src/server/session.ts';
import VersionReviewPage from './page.tsx';

// The version review page: the view gate, the reads it makes (the version, its photos, category
// names only with the tree key, the next pending version), and its states.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  view: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../../../../../src/catalog/version-review/version-review.tsx', () => ({
  VersionReview: (props: Record<string, unknown>) => {
    mocks.view(props);
    return <p>the version</p>;
  },
}));

const P = '0190a000-0000-7000-8000-0000000000d1';
const R = '0190a000-0000-7000-8000-0000000000e2';
const NEXT = '0190a000-0000-7000-8000-0000000000e3';
const CAT = '0190a000-0000-7000-8000-000000000301';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const params = (productId = P, revisionId = R) => ({
  params: Promise.resolve({ productId, revisionId }),
});
const answers: Record<string, unknown> = {
  [`catalog/admin/products/${P}/revisions/${R}`]: { state: 'pending' },
  [`catalog/admin/products/${P}/revisions/${R}/images`]: {
    images: [{ imageId: 'i', position: 1, state: 'clean', width: 1, height: 1 }],
  },
  'catalog/admin/categories': {
    categories: [
      {
        id: CAT,
        names: [
          { locale: 'ar', name: 'زيوت' },
          { locale: 'en-AU', name: 'Oils' },
        ],
      },
    ],
  },
  'catalog/admin/review-queue?kind=product-revision&limit=2': {
    items: [
      { productId: P, revisionId: R },
      { productId: P, revisionId: NEXT },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    kind: 'ok',
    session: session([
      'catalog.product.view',
      'catalog.product.approve',
      'catalog.product.delete',
      'catalog.category-tree.view',
    ]),
  });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(path in answers ? { kind: 'ok', body: answers[path] } : { kind: 'not-found' }),
  );
});
afterEach(cleanup);

describe('version review page', () => {
  it('reads the version, its photos, category names and the next pending version', async () => {
    render(await VersionReviewPage(params()));
    expect(screen.getByText('the version')).toBeTruthy();
    const props = mocks.view.mock.calls[0]![0] as Record<string, unknown>;
    expect(props['canDecide']).toBe(true);
    expect(props['canTakeDown']).toBe(true);
    expect(props['categoryNames']).toEqual({ [CAT]: 'Oils' });
    expect(props['images']).toHaveLength(1);
    expect(props['nextHref']).toBe(`/review/products/${P}/revisions/${NEXT}`);
  });

  it('passes no photo list when it cannot be read, and sends a signed-out admin away', async () => {
    const photos = `catalog/admin/products/${P}/revisions/${R}/images`;
    const answering = (kind: string) => (path: string) =>
      Promise.resolve(
        path === photos
          ? { kind }
          : path in answers
            ? { kind: 'ok', body: answers[path] }
            : { kind: 'not-found' },
      );
    mocks.get.mockImplementation(answering('unavailable'));
    render(await VersionReviewPage(params()));
    expect((mocks.view.mock.calls[0]![0] as Record<string, unknown>)['images']).toBeNull();
    mocks.get.mockImplementation(answering('signed-out'));
    await expect(VersionReviewPage(params())).rejects.toThrow('redirect:/session-ended');
  });

  it('reads no category tree without its key, and no queue for a decided version', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.product.view']) });
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith(R)
          ? { kind: 'ok', body: { state: 'closed' } }
          : { kind: 'ok', body: answers[path] },
      ),
    );
    render(await VersionReviewPage(params()));
    const paths = mocks.get.mock.calls.map((call) => call[0] as string);
    expect(paths).not.toContain('catalog/admin/categories');
    expect(paths.some((path) => path.startsWith('catalog/admin/review-queue'))).toBe(false);
    const props = mocks.view.mock.calls[0]![0] as Record<string, unknown>;
    expect(props['canDecide']).toBe(false);
    expect(props['canTakeDown']).toBe(false);
    expect(props['nextHref']).toBeNull();
  });

  it('reads nothing without catalog.product.view or with an id that is not a UUID', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await VersionReviewPage(params()));
    expect(screen.getByText(messages.catalog.queue['no-access'])).toBeTruthy();
    cleanup();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['catalog.product.view']) });
    render(await VersionReviewPage(params('nope')));
    expect(screen.getByText(messages.catalog.version['not-found'])).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to queue' }).getAttribute('href')).toBe(
      '/review',
    );
  });

  it('says a missing version is not found, an unavailable read is an error, and signed out ends', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'not-found' });
    render(await VersionReviewPage(params()));
    expect(screen.getByText(messages.catalog.version['not-found'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await VersionReviewPage(params()));
    expect(screen.getByText(messages.catalog.version.unavailable)).toBeTruthy();
    mocks.get.mockResolvedValueOnce({ kind: 'signed-out' });
    await expect(VersionReviewPage(params())).rejects.toThrow('redirect:/session-ended');
  });
});
