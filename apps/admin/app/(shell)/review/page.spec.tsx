// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import ReviewQueuePage from './page.tsx';
import OfferReviewsPage from '../offer-reviews/page.tsx';

// The review queue page: the view gate (no list without catalog.product.view), the list paging
// setting, the tab the URL names, and the old Offer reviews address.

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
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'admin.localhost' })),
}));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../src/catalog/review-queue-view.tsx', () => ({
  ReviewQueueView: (props: Readonly<Record<string, string>>) => (
    <p
      data-testid="view"
      {...Object.fromEntries(Object.entries(props).map(([k, v]) => [`data-${k}`, v]))}
    >
      view
    </p>
  ),
}));

const VIEW = 'catalog.product.view';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  marketTimezone: 'UTC',
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const search = (values: Record<string, string> = {}) => ({
  searchParams: Promise.resolve(values),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
});
afterEach(cleanup);

describe('review queue page', () => {
  it('opens the revisions list with the Market, the account and the paging setting', async () => {
    render(await ReviewQueuePage(search()));
    expect(screen.getByRole('heading', { level: 1, name: 'Catalogue requests' })).toBeTruthy();
    const view = screen.getByTestId('view');
    expect(view.getAttribute('data-tab')).toBe('revision');
    expect(view.getAttribute('data-paging')).toBe('pages');
    expect(view.getAttribute('data-marketid')).toBe('AU');
    expect(view.getAttribute('data-accountid')).toBe('a');
    expect(view.getAttribute('data-csrftoken')).toBe('c');
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
  });

  it('opens the Offers list for ?type=offer, and Previous and next when paging is unreadable', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await ReviewQueuePage(search({ type: 'offer' })));
    const view = screen.getByTestId('view');
    expect(view.getAttribute('data-tab')).toBe('offer');
    expect(view.getAttribute('data-paging')).toBe('prev-next');
  });

  it('shows no list without catalog.product.view, and still has a heading and a way back', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await ReviewQueuePage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('view')).toBeNull();
    expect(screen.getByText(messages.catalog.queue['no-access'])).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.catalog.review['back-home'] })).toBeTruthy();
  });

  it('shows an error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await ReviewQueuePage(search()));
    expect(screen.getByText(messages.identity.error.unknown)).toBeTruthy();
  });

  it('sends the old Offer reviews address to the Offers tab', () => {
    expect(() => OfferReviewsPage()).toThrow('redirect:/review?type=offer');
  });
});
