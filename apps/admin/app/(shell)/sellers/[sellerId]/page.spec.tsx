// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import type * as AiAccessModule from '../../../../src/sellers/ai-access-card.tsx';
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
vi.mock('../../../../src/sellers/category-proposals-card.tsx', () => ({
  CategoryProposalsCard: ({ canSeeQueue }: { canSeeQueue: boolean }) => (
    <section data-can-see-queue={String(canSeeQueue)}>category proposals card</section>
  ),
}));
vi.mock('../../../../src/sellers/health-card.tsx', () => ({ SellerHealthCard: () => <div /> }));
vi.mock('../../../../src/sellers/ai-access-card.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof AiAccessModule>()),
  AiAccessCard: ({ initial }: { initial: { enabled: boolean } | null }) => (
    <section data-initial={initial === null ? 'none' : String(initial.enabled)}>
      ai access card
    </section>
  ),
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

describe('admin seller page: May propose categories', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({ kind: 'ok', body: {} });
  });
  afterEach(cleanup);

  it('shows the switch only to a holder of the seller settings key, and the shelves link by the decide key', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['sellers.business-details.view']),
    });
    await show();
    expect(screen.queryByText('category proposals card')).toBeNull();
    cleanup();
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['sellers.business-details.view', 'sellers.seller-settings.edit']),
    });
    await show();
    expect(screen.getByText('category proposals card').getAttribute('data-can-see-queue')).toBe(
      'false',
    );
    cleanup();
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([
        'sellers.business-details.view',
        'sellers.seller-settings.edit',
        'catalog.category-proposal.decide',
      ]),
    });
    await show();
    expect(screen.getByText('category proposals card').getAttribute('data-can-see-queue')).toBe(
      'true',
    );
  });
});

describe('admin seller page: AI writing help card', () => {
  const REVIEW = 'sellers.business-details.view';
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve({
        kind: 'ok',
        body: path.endsWith('/ai-access') ? { enabled: true, changedAt: null } : {},
      }),
    );
  });
  afterEach(cleanup);

  it('shows the card only to an actor who may edit seller settings', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([REVIEW]) });
    await show();
    expect(screen.queryByText('ai access card')).toBeNull();
  });

  it('hands the card the setting it read, with the seller view key', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([REVIEW, 'sellers.seller-settings.edit', 'sellers.seller.view']),
    });
    await show();
    expect(screen.getByText('ai access card').getAttribute('data-initial')).toBe('true');
    expect(mocks.get).toHaveBeenCalledWith(`sellers/admin/${SELLER}/ai-access`);
  });

  it('reads nothing without the view key and the card then shows no switch', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([REVIEW, 'sellers.seller-settings.edit']),
    });
    await show();
    expect(screen.getByText('ai access card').getAttribute('data-initial')).toBe('none');
    expect(mocks.get).not.toHaveBeenCalledWith(`sellers/admin/${SELLER}/ai-access`);
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
