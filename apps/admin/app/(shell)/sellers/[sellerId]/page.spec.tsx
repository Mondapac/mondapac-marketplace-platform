// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import SellerReviewPage from './page.tsx';

const mocks = vi.hoisted(() => ({ get: vi.fn(), session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('not-found');
  },
}));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/sellers/review-view.tsx', () => ({ ReviewView: () => <div /> }));
vi.mock('../../../../src/sellers/owner-second-factor-card.tsx', () => ({
  OwnerSecondFactorCard: () => <section>owner reset card</section>,
}));
vi.mock('../../../../src/commission/rate-card.tsx', () => ({ CommissionRateCard: () => <div /> }));
vi.mock('../../../../src/commission/ledger-card.tsx', () => ({ LedgerCard: () => <div /> }));
vi.mock('../../../../src/payouts/terms-card.tsx', () => ({
  PayoutTermsCard: ({ currency, canEdit }: { currency: string | null; canEdit: boolean }) => (
    <section data-currency={String(currency)} data-can-edit={String(canEdit)}>
      payout terms card
    </section>
  ),
}));
vi.mock('../../../../src/payouts/holds-card.tsx', () => ({
  PayoutHoldsCard: ({ canPlace, canRelease }: { canPlace: boolean; canRelease: boolean }) => (
    <section data-can-place={String(canPlace)} data-can-release={String(canRelease)}>
      payout holds card
    </section>
  ),
}));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const SELLER = '0190a000-0000-7000-8000-0000000000a1';
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
const show = async () =>
  render(await SellerReviewPage({ params: Promise.resolve({ sellerId: SELLER }) }));

describe('admin seller page: the owner two-step reset card', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({ kind: 'ok', body: {} });
  });
  afterEach(cleanup);

  it('shows the card only to an actor who holds the reset key', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['sellers.business-details.view']),
    });
    await show();
    expect(screen.queryByText('owner reset card')).toBeNull();
    cleanup();
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([
        'sellers.business-details.view',
        'identity.seller-account.reset-second-factor',
      ]),
    });
    await show();
    expect(screen.getByText('owner reset card')).toBeTruthy();
  });
});

describe('admin seller page: payout terms and holds', () => {
  const REVIEW = 'sellers.business-details.view';
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve({
        kind: 'ok',
        body: path.endsWith('payout-holds')
          ? { holds: [] }
          : path.endsWith('/ledger?limit=20')
            ? { currency: 'AUD', entries: [], totals: {}, nextCursor: null }
            : {},
      }),
    );
  });
  afterEach(cleanup);

  it('reads nothing and shows no card without the keys', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([REVIEW]) });
    await show();
    expect(screen.queryByText('payout terms card')).toBeNull();
    expect(screen.queryByText('payout holds card')).toBeNull();
    const paths = mocks.get.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => path.includes('payout-terms'))).toBe(false);
    expect(paths.some((path) => path.includes('payout-holds'))).toBe(false);
  });

  it('shows the terms to a holder of the view key, with the ledger currency, and whether they may edit', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([
        REVIEW,
        'commission-payouts.settlement.view',
        'commission-payouts.payout-terms.view',
      ]),
    });
    const { container } = await show();
    expect(screen.getByText('payout terms card')).toBeTruthy();
    expect(container.querySelector('[data-currency]')?.getAttribute('data-currency')).toBe('AUD');
    expect(container.querySelector('[data-can-edit]')?.getAttribute('data-can-edit')).toBe('false');
  });

  it('shows the holds with the place and release keys told apart', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([
        REVIEW,
        'commission-payouts.settlement.view',
        'commission-payouts.payout-hold.place',
      ]),
    });
    const { container } = await show();
    expect(screen.getByText('payout holds card')).toBeTruthy();
    expect(container.querySelector('[data-can-place]')?.getAttribute('data-can-place')).toBe(
      'true',
    );
    expect(container.querySelector('[data-can-release]')?.getAttribute('data-can-release')).toBe(
      'false',
    );
  });
});
