// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import PayoutAccountsPage from './page.tsx';

// The Seller accounts page: the permission gate (no list without payments.connected-account.view),
// and what it hands the super list (the Market's List paging, the Market and the zone).

const mocks = vi.hoisted(() => ({ get: vi.fn(), session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/payments/accounts-list.tsx', () => ({
  AccountsList: (props: {
    readonly paging: string;
    readonly marketId: string;
    readonly zone: string;
  }) => (
    <p data-paging={props.paging} data-market={props.marketId} data-zone={props.zone}>
      the list
    </p>
  ),
}));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const VIEW = 'payments.connected-account.view';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: 'Australia/Brisbane',
  marketTimezone: 'UTC',
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const list = () => document.querySelector('[data-paging]');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
});
afterEach(cleanup);

describe('seller accounts page', () => {
  it('hands the list the List paging setting, the Market and the admin zone', async () => {
    render(await PayoutAccountsPage());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(list()?.getAttribute('data-paging')).toBe('pages');
    expect(list()?.getAttribute('data-market')).toBe('AU');
    expect(list()?.getAttribute('data-zone')).toBe('Australia/Brisbane');
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
  });

  it('uses Previous and next when the List paging setting cannot be read', async () => {
    mocks.get.mockResolvedValue({ kind: 'failed' });
    render(await PayoutAccountsPage());
    expect(list()?.getAttribute('data-paging')).toBe('prev-next');
  });

  it('shows no list and reads nothing without the view key', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await PayoutAccountsPage());
    expect(list()).toBeNull();
    expect(screen.getByText("You don't have access to seller accounts.")).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('keeps its heading when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await PayoutAccountsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Seller accounts' })).toBeTruthy();
  });
});
