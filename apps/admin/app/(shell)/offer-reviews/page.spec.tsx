// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import OfferReviewsPage from './page.tsx';
import OfferChangePage from './[changeId]/page.tsx';

// The Offer review queue pages: the view gate, the tab the URL names, the paging setting and the
// deep link of one held edit.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
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
vi.mock('../../../src/offer-review/queue.tsx', () => ({
  OfferReviewQueue: (props: Readonly<Record<string, unknown>>) => (
    <p
      data-testid="queue"
      data-tab={String(props['tab'])}
      data-paging={String(props['paging'])}
      data-market={String(props['marketId'])}
      data-decide={String(props['canDecide'])}
    >
      queue
    </p>
  ),
}));
vi.mock('../../../src/offer-review/change-page.tsx', () => ({
  ChangePage: (props: { readonly change: { readonly changeId: string } }) => (
    <p data-testid="change">{props.change.changeId}</p>
  ),
}));

const VIEW = 'catalog.product.view';
const APPROVE = 'catalog.product.approve';
const CHANGE_ID = '0190a000-0000-7000-8000-0000000000a1';
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
const search = (values: Record<string, string> = {}) => ({ searchParams: Promise.resolve(values) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
});
afterEach(cleanup);

describe('Offer reviews page', () => {
  it('has the title and no subtitle, opens First publications, and passes the paging and Market', async () => {
    render(await OfferReviewsPage(search()));
    const heading = screen.getByRole('heading', { level: 1, name: 'Offer reviews' });
    expect(heading).toBeTruthy();
    const queue = screen.getByTestId('queue');
    expect(queue.getAttribute('data-tab')).toBe('first');
    expect(queue.getAttribute('data-paging')).toBe('pages');
    expect(queue.getAttribute('data-market')).toBe('AU');
    expect(queue.getAttribute('data-decide')).toBe('false');
  });

  it('opens Edits for ?tab=edits, lets an approver decide, and falls back to Previous and next', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, APPROVE]) });
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await OfferReviewsPage(search({ tab: 'edits' })));
    const queue = screen.getByTestId('queue');
    expect(queue.getAttribute('data-tab')).toBe('edits');
    expect(queue.getAttribute('data-paging')).toBe('prev-next');
    expect(queue.getAttribute('data-decide')).toBe('true');
  });

  it('names the missing permission and makes no call without catalog.product.view', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await OfferReviewsPage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('queue')).toBeNull();
    expect(screen.getByText(/catalog\.product\.view/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
});

describe('Offer change deep link', () => {
  const params = (changeId: string) => ({ params: Promise.resolve({ changeId }) });

  it('reads the change by id and shows it', async () => {
    mocks.get.mockResolvedValue({
      kind: 'ok',
      body: {
        changeId: CHANGE_ID,
        product: { name: 'Medjool dates', productCode: null },
        offer: null,
        offerId: 'o',
      },
    });
    render(await OfferChangePage(params(CHANGE_ID)));
    expect(mocks.get).toHaveBeenCalledWith(`catalog/admin/offer-changes/${CHANGE_ID}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Medjool dates' })).toBeTruthy();
    expect(screen.getByTestId('change').textContent).toBe(CHANGE_ID);
  });

  it('is not found for a malformed id and for an unknown change, and denied without the view key', async () => {
    await expect(OfferChangePage(params('nope'))).rejects.toThrow('not-found');
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    render(await OfferChangePage(params(CHANGE_ID)));
    expect(screen.getByText('Review not found')).toBeTruthy();
    cleanup();
    mocks.get.mockClear();
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await OfferChangePage(params(CHANGE_ID)));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText('No access')).toBeTruthy();
  });

  it('shows a retry when the change cannot be read', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await OfferChangePage(params(CHANGE_ID)));
    expect(screen.getByText(messages['offer-review'].change.unavailable)).toBeTruthy();
  });
});
