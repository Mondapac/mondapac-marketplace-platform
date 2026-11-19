// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import PayoutsPageRoute from './page.tsx';
import PayoutPageRoute from './[payoutId]/page.tsx';

// The two payout pages: the permission gate (no API read without
// commission-payouts.payout.view), what the list page hands the Payouts super list (the view of
// the link, a seller, the Market's List paging), today's total, and a heading on every branch.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/payouts/payouts-list.tsx', () => ({
  PayoutsList: (props: {
    readonly initialView: string;
    readonly sellerId: string | null;
    readonly paging: string;
    readonly marketId: string;
  }) => (
    <p
      data-view={props.initialView}
      data-seller={props.sellerId ?? ''}
      data-paging={props.paging}
      data-market={props.marketId}
    >
      the list
    </p>
  ),
}));
vi.mock('../../../src/payouts/payout-detail.tsx', () => ({
  PayoutDetailView: ({ canApprove }: { readonly canApprove: boolean }) => (
    <p data-can-approve={String(canApprove)}>the payout</p>
  ),
}));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const VIEW = 'commission-payouts.payout.view';
const APPROVE = 'commission-payouts.payout.approve';
const ID = '0190a000-0000-7000-8000-0000000000a1';
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
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
const search = (status?: string, sellerId?: string) => ({
  searchParams: Promise.resolve({ status, sellerId }),
});
const params = (payoutId = ID) => ({ params: Promise.resolve({ payoutId }) });
const limits = {
  perTransfer: aud('500000'),
  todayTotal: aud('1500000'),
  dailyAlertLevel: aud('2000000'),
  overDailyAlertLevel: false,
  transferAboveLimit: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockImplementation((path: string) => {
    if (path === 'settings/admin/list-paging')
      return Promise.resolve({ kind: 'ok', body: { listPaging: 'pages' } });
    if (path.includes('limit=1'))
      return Promise.resolve({
        kind: 'ok',
        body: { payouts: [{ payoutId: ID }], nextCursor: null },
      });
    return Promise.resolve({ kind: 'ok', body: { payoutId: ID, limits } });
  });
});
afterEach(cleanup);

describe('payouts list page', () => {
  it('shows one heading and opens the list on the view of the link', async () => {
    render(await PayoutsPageRoute(search('failed')));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const list = document.querySelector('[data-view]');
    expect(list?.getAttribute('data-view')).toBe('failed');
    expect(list?.getAttribute('data-paging')).toBe('pages');
    expect(list?.getAttribute('data-market')).toBe('AU');
    // The views and their counts are the list's own (the super list reads them with its rows).
    expect(screen.queryByRole('navigation', { name: 'Payouts by stage' })).toBeNull();
  });

  it('opens on Awaiting approval without a view, or for an unknown one', async () => {
    render(await PayoutsPageRoute(search()));
    expect(document.querySelector('[data-view]')?.getAttribute('data-view')).toBe(
      'awaiting-approval',
    );
    cleanup();
    render(await PayoutsPageRoute(search('everything')));
    expect(document.querySelector('[data-view]')?.getAttribute('data-view')).toBe(
      'awaiting-approval',
    );
  });

  it('hands the list one seller of a link, and ignores a seller id that is not an id', async () => {
    render(await PayoutsPageRoute(search('all', SELLER.toUpperCase())));
    expect(document.querySelector('[data-seller]')?.getAttribute('data-seller')).toBe(SELLER);
    cleanup();
    render(await PayoutsPageRoute(search('all', 'drop table')));
    expect(document.querySelector('[data-seller]')?.getAttribute('data-seller')).toBe('');
  });

  it('uses Previous and next when the List paging setting cannot be read', async () => {
    mocks.get.mockImplementation((path: string) => Promise.resolve({ kind: 'unavailable', path }));
    render(await PayoutsPageRoute(search()));
    expect(document.querySelector('[data-paging]')?.getAttribute('data-paging')).toBe('prev-next');
  });

  it("shows today's total against the alert level, read from the newest payout", async () => {
    render(await PayoutsPageRoute(search()));
    expect(
      screen.getByText('Transfers sent today: $15,000.00 of $20,000.00 alert level.'),
    ).toBeTruthy();
    expect(screen.queryByText('Above the alert level')).toBeNull();
  });

  it('flags a total above the alert level', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/payouts/')
          ? { kind: 'ok', body: { limits: { ...limits, overDailyAlertLevel: true } } }
          : path === 'settings/admin/list-paging'
            ? { kind: 'ok', body: { listPaging: 'pages' } }
            : { kind: 'ok', body: { payouts: [{ payoutId: ID }], nextCursor: null } },
      ),
    );
    render(await PayoutsPageRoute(search()));
    expect(screen.getByText('Above the alert level')).toBeTruthy();
  });

  it('shows no totals line when there is no payout yet or it cannot be read', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await PayoutsPageRoute(search()));
    expect(screen.queryByText(/Transfers sent today/)).toBeNull();
    expect(screen.getByText('the list')).toBeTruthy();
  });

  it('makes no read without the view permission, but keeps a heading and a way back', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await PayoutsPageRoute(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.payouts['no-access'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Payouts' })).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.payouts['back-home'] })).toBeTruthy();
  });

  it('keeps its heading when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await PayoutsPageRoute(search()));
    expect(screen.getByRole('heading', { level: 1, name: 'Payouts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('payout detail page', () => {
  it('refuses without the view permission and never calls the API', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([APPROVE]) });
    render(await PayoutPageRoute(params()));
    expect(screen.getByText(messages.payouts['no-access'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'No access' })).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads the payout and tells the view whether this admin may approve', async () => {
    const { container, rerender } = render(await PayoutPageRoute(params()));
    expect(mocks.get).toHaveBeenCalledWith(`commission-payouts/admin/payouts/${ID}`);
    expect(container.querySelector('[data-can-approve]')?.getAttribute('data-can-approve')).toBe(
      'false',
    );
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, APPROVE]) });
    rerender(await PayoutPageRoute(params()));
    expect(container.querySelector('[data-can-approve]')?.getAttribute('data-can-approve')).toBe(
      'true',
    );
  });

  it('answers not-found for a bad id without any read, and for an unknown payout', async () => {
    await expect(PayoutPageRoute(params('nope'))).rejects.toThrow('not-found');
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    render(await PayoutPageRoute(params()));
    expect(screen.getByRole('heading', { level: 1, name: 'Payout not found' })).toBeTruthy();
  });

  it('sends a signed-out admin to the session-ended route, and shows a retry when unavailable', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(PayoutPageRoute(params())).rejects.toThrow('redirect:/session-ended');
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await PayoutPageRoute(params()));
    expect(screen.getByRole('heading', { level: 1, name: 'Payout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
