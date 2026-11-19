// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import SellersPage from './page.tsx';
import SellersWithoutOwnerPage from './without-owner/page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn(), get: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
  }) => <main data-active={activeId}>{children}</main>,
}));
vi.mock('../../../src/sellers/sellers-list.tsx', () => ({
  SellersList: ({
    initialTab,
    paging,
  }: {
    readonly initialTab: string;
    readonly paging: string;
  }) => (
    <p>
      sellers list on {initialTab} paging {paging}
    </p>
  ),
}));
vi.mock('../../../src/sellers/orphaned-list.tsx', () => ({
  OrphanedList: () => <p>orphaned list</p>,
}));

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
const signedIn = (...keys: string[]) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });

afterEach(cleanup);
beforeEach(() => mocks.get.mockResolvedValue({ kind: 'unavailable' }));

describe('the sellers pages and identity.seller-access.view', () => {
  it('opens on All under Sellers, and on the review tab under Inbox › Seller requests', async () => {
    signedIn('sellers.seller.view');
    render(await SellersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('main').getAttribute('data-active')).toBe('sellers');
    expect(screen.getByText('sellers list on all paging prev-next')).not.toBeNull();
    cleanup();
    render(await SellersPage({ searchParams: Promise.resolve({ tab: 'awaiting-review' }) }));
    expect(screen.getByRole('main').getAttribute('data-active')).toBe('seller-requests');
    expect(screen.getByText('sellers list on awaiting-review paging prev-next')).not.toBeNull();
  });

  it('passes the Market list-paging setting to the list', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
    signedIn('sellers.seller.view');
    render(await SellersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('sellers list on all paging pages')).not.toBeNull();
  });

  it('shows the "Sellers without an owner" link on /sellers only with the key', async () => {
    signedIn('sellers.seller.view', 'identity.seller-access.view');
    render(await SellersPage({ searchParams: Promise.resolve({}) }));
    const link = screen.getByRole('link', { name: 'Sellers without an owner' });
    expect(link.getAttribute('href')).toBe('/sellers/without-owner');
    cleanup();
    signedIn('sellers.seller.view');
    render(await SellersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole('link', { name: 'Sellers without an owner' })).toBeNull();
  });

  it('shows the "Sellers that need a look" link only with sellers.seller.view', async () => {
    signedIn('sellers.seller.view');
    render(await SellersPage({ searchParams: Promise.resolve({}) }));
    expect(
      screen.getByRole('link', { name: 'Sellers that need a look' }).getAttribute('href'),
    ).toBe('/sellers/needs-a-look');
    cleanup();
    signedIn('identity.seller-access.view');
    render(await SellersPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole('link', { name: 'Sellers that need a look' })).toBeNull();
  });

  it('renders the list on the new page with the key, and the no-access text without it', async () => {
    signedIn('identity.seller-access.view');
    render(await SellersWithoutOwnerPage());
    expect(screen.getByText('orphaned list')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to sellers' })).toBeTruthy();
    cleanup();
    signedIn('sellers.seller.view');
    render(await SellersWithoutOwnerPage());
    expect(screen.queryByText('orphaned list')).toBeNull();
    expect(screen.getByText("You don't have access to this page")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Dashboard' })).toBeTruthy();
  });
});
