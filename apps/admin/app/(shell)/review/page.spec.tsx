// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import ReviewQueuePage from './page.tsx';
import OfferReviewsPage from '../offer-reviews/page.tsx';

// The review queue page: the view gate (no API read without catalog.product.view), the states of
// the queue read, the tab counts from `totals`, and the old Offer reviews address.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../src/catalog/revision-queue.tsx', () => ({
  RevisionFilters: () => <p>revision filters</p>,
  RevisionQueueTable: ({ rows }: { readonly rows: readonly unknown[] }) => (
    <p>{`${rows.length} revision rows`}</p>
  ),
  SellerChip: () => null,
  QueueEmpty: ({ morePages }: { readonly morePages: boolean }) => (
    <p>{morePages ? 'empty page' : 'empty queue'}</p>
  ),
}));
vi.mock('../../../src/catalog/review-queue.tsx', () => ({
  ReviewQueue: ({
    rows,
    canDecide,
  }: {
    readonly rows: readonly unknown[];
    readonly canDecide: boolean;
  }) => <p data-can-decide={String(canDecide)}>{`${rows.length} offer cards`}</p>,
}));

const VIEW = 'catalog.product.view';
const DECIDE = 'catalog.product.approve';
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
const search = (values: Record<string, string> = {}) => ({
  searchParams: Promise.resolve(values),
});
const page = (items: unknown[], nextAfterId: string | null = null) => ({
  kind: 'ok',
  body: {
    items,
    nextAfterId,
    total: items.length,
    totals: { 'product-revision': 12, 'offer-first-publication': 3 },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, DECIDE]) });
  mocks.get.mockResolvedValue(page([{ kind: 'product-revision', sellerId: 's' }]));
});
afterEach(cleanup);

describe('review queue page', () => {
  it('reads the revisions kind and shows both tab counts from totals', async () => {
    render(await ReviewQueuePage(search()));
    expect(mocks.get).toHaveBeenCalledWith(
      'catalog/admin/review-queue?kind=product-revision&limit=25',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Review queue' })).toBeTruthy();
    const revisions = screen.getByRole('link', { name: 'Product revisions (12)' });
    expect(revisions.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Offers (3)' }).getAttribute('href')).toBe(
      '/review?type=offer',
    );
    expect(screen.getByText('revision filters')).toBeTruthy();
    expect(screen.getByText('1 revision rows')).toBeTruthy();
  });

  it('shows the Offers tab with the decide permission passed on', async () => {
    mocks.get.mockResolvedValue(page([{ kind: 'offer-first-publication', sellerId: 's' }]));
    render(await ReviewQueuePage(search({ type: 'offer', change: 'new' })));
    expect(mocks.get).toHaveBeenCalledWith(
      'catalog/admin/review-queue?kind=offer-first-publication&limit=25',
    );
    expect(screen.getByText('1 offer cards').getAttribute('data-can-decide')).toBe('true');
    expect(screen.queryByText('revision filters')).toBeNull();
  });

  it('links the next page with the filters kept, and says an empty page is not an empty queue', async () => {
    const next = '1730000000000_0190a000-0000-7000-8000-0000000000e9';
    mocks.get.mockResolvedValue(page([], next));
    render(await ReviewQueuePage(search({ change: 'update' })));
    expect(screen.getByText('empty page')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      `/review?change=update&after=${next}`,
    );
  });

  it('reads nothing without catalog.product.view, and still has a heading and a way back', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await ReviewQueuePage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.catalog.queue['no-access'])).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.catalog.review['back-home'] })).toBeTruthy();
  });

  it('treats a refused read as no access, an unavailable one as an error, and a signed-out one as ended', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'forbidden' });
    render(await ReviewQueuePage(search()));
    expect(screen.getByText(messages.catalog.queue['no-access'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await ReviewQueuePage(search()));
    expect(screen.getByText(messages.catalog.queue.unavailable)).toBeTruthy();
    mocks.get.mockResolvedValueOnce({ kind: 'signed-out' });
    await expect(ReviewQueuePage(search())).rejects.toThrow('redirect:/session-ended');
  });

  it('sends the old Offer reviews address to the Offers tab', () => {
    expect(() => OfferReviewsPage()).toThrow('redirect:/review?type=offer');
  });
});
