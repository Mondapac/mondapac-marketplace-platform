// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import SellersPage from './page.tsx';
import SellersWithoutOwnerPage from './without-owner/page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../src/sellers/sellers-list.tsx', () => ({
  SellersList: () => <p>sellers list</p>,
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
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const signedIn = (...keys: string[]) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });

afterEach(cleanup);

describe('the sellers pages and identity.seller-access.view', () => {
  it('shows the "Sellers without an owner" link on /sellers only with the key', async () => {
    signedIn('sellers.seller.view', 'identity.seller-access.view');
    render(await SellersPage());
    const link = screen.getByRole('link', { name: 'Sellers without an owner' });
    expect(link.getAttribute('href')).toBe('/sellers/without-owner');
    cleanup();
    signedIn('sellers.seller.view');
    render(await SellersPage());
    expect(screen.queryByRole('link', { name: 'Sellers without an owner' })).toBeNull();
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
