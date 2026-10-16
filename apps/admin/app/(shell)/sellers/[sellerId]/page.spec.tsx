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
