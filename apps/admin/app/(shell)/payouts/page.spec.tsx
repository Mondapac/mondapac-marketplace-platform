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
// commission-payouts.payout.view), the server-rendered tabs with their counts, and a heading on
// every branch.

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
vi.mock('../../../src/payouts/payouts-list.tsx', () => ({
  PayoutsList: ({ tab, canApprove }: { readonly tab: string; readonly canApprove: boolean }) => (
    <p data-tab={tab} data-can-approve={String(canApprove)}>
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
const aud = (amountMinor: string) => ({ amountMinor, currency: 'AUD' });
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
const search = (status?: string) => ({ searchParams: Promise.resolve({ status }) });
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
    if (path.includes('status=awaiting-approval'))
      return Promise.resolve({
        kind: 'ok',
        body: { payouts: [{ payoutId: ID }, { payoutId: ID }], nextCursor: null },
      });
    if (path.includes('status=failed'))
      return Promise.resolve({
        kind: 'ok',
        body: { payouts: [{ payoutId: ID }], nextCursor: 'c' },
      });
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
  it('shows one heading, the tabs with the counts the API gives, and the list of the tab', async () => {
    render(await PayoutsPageRoute(search('failed')));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Payouts by stage' });
    expect(nav.textContent).toContain('Awaiting approval (2)');
    // One page of the API: a next cursor reads as "100+" rather than a wrong total.
    expect(nav.textContent).toContain('Failed (1+)');
    expect(nav.textContent).toContain('Paid');
    expect(screen.getByRole('link', { name: /^Failed/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: /^Awaiting approval/ }).getAttribute('href')).toBe(
      '/payouts',
    );
    expect(screen.getByRole('link', { name: 'Paid' }).getAttribute('href')).toBe(
      '/payouts?status=paid',
    );
    expect(document.querySelector('[data-tab]')?.getAttribute('data-tab')).toBe('failed');
  });

  it('falls back to Awaiting approval for an unknown status', async () => {
    render(await PayoutsPageRoute(search('everything')));
    expect(document.querySelector('[data-tab]')?.getAttribute('data-tab')).toBe(
      'awaiting-approval',
    );
  });

  it("shows today's total against the alert level, read from the newest payout", async () => {
    render(await PayoutsPageRoute(search()));
    expect(screen.getByText('$15,000.00')).toBeTruthy();
    expect(screen.getByText('$20,000.00')).toBeTruthy();
    expect(screen.getByText("Today's total is below the alert level.")).toBeTruthy();
  });

  it('shows no totals card when there is no payout yet, and tabs without counts when unreadable', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await PayoutsPageRoute(search()));
    expect(screen.queryByText('Sent today')).toBeNull();
    expect(screen.getByRole('link', { name: 'Awaiting approval' })).toBeTruthy();
  });

  it('tells the list whether this admin may approve', async () => {
    const { rerender } = render(await PayoutsPageRoute(search()));
    expect(document.querySelector('[data-can-approve]')?.getAttribute('data-can-approve')).toBe(
      'false',
    );
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, APPROVE]) });
    rerender(await PayoutsPageRoute(search()));
    expect(document.querySelector('[data-can-approve]')?.getAttribute('data-can-approve')).toBe(
      'true',
    );
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
