// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import CustomerDetailPage from './[accountId]/page.tsx';
import CustomersPage from './page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  list: vi.fn(),
  page: vi.fn(),
}));

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
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'admin.localhost:3002' })),
}));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({ marketName: 'Test' }) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../src/customers/customers-list.tsx', () => ({
  CustomersList: (props: unknown) => {
    mocks.list(props);
    return <div>list</div>;
  },
}));
vi.mock('../../../src/customers/customer-page.tsx', () => ({
  CustomerPage: (props: unknown) => {
    mocks.page(props);
    return <div>customer</div>;
  },
}));

const VIEW = 'customers.customers.view';
const DELETE = 'customers.buyer-account.delete';
const SETTINGS_VIEW = 'customers.account-deletion-settings.view';
const ID = '0190a000-0000-7000-8000-0000000000a1';
const as = (...permissionKeys: string[]) =>
  mocks.session.mockResolvedValue({
    kind: 'ok',
    session: {
      accountId: 'admin-1',
      roleId: 'r',
      permissionKeys,
      secondFactorActive: true,
      lastSignInAt: null,
      timezone: null,
      marketTimezone: 'Australia/Brisbane',
      locale: null,
      email: 'ada@example.test',
      displayName: 'Ada',
      csrfToken: 'c',
    } satisfies AdminSession,
  });

const settingsAnswer = {
  kind: 'ok',
  body: { version: 1, settings: { enabled: true, waitingPeriodDays: 14 } },
};
const pagingAnswer = (listPaging: string) => ({ kind: 'ok', body: { listPaging } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(path === 'settings/admin/list-paging' ? pagingAnswer('pages') : settingsAnswer),
  );
});
afterEach(cleanup);

describe('Customers list page', () => {
  it('shows the super list to a holder of customers.customers.view, with the Market paging', async () => {
    as(VIEW);
    render(await CustomersPage());
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        paging: 'pages',
        marketId: 'AU',
        csrfToken: 'c',
      }),
    );
  });

  it('falls back to Previous and next when the paging setting cannot be read', async () => {
    as(VIEW);
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await CustomersPage());
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ paging: 'prev-next' }));
  });

  it('shows no list without the view key (the old identity key is not enough)', async () => {
    as('identity.customer-account.view', DELETE);
    render(await CustomersPage());
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.getByText(/You don't have access to customers/)).toBeTruthy();
  });
});

describe('Customer page', () => {
  const open = async (accountId = ID, tab?: string) =>
    CustomerDetailPage({
      params: Promise.resolve({ accountId }),
      searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
    });

  it('is not found for an id that is not a UUID, before any read', async () => {
    as(VIEW);
    await expect(open('not-an-id')).rejects.toThrow('not-found');
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it('opens on the tab in the address, and on Overview for an unknown one', async () => {
    as(VIEW);
    render(await open(ID, 'money'));
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ initialTab: 'money' }));
    cleanup();
    render(await open(ID, 'secret'));
    expect(mocks.page).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialTab: 'overview' }),
    );
  });

  it('reads the waiting period only for an admin who may delete and read the setting', async () => {
    as(VIEW, DELETE);
    render(await open());
    expect(mocks.page).toHaveBeenLastCalledWith(
      expect.objectContaining({ waitingPeriodDays: null }),
    );
    expect(mocks.get).not.toHaveBeenCalledWith('customers/admin/account-deletion-settings');
    cleanup();
    as(VIEW, DELETE, SETTINGS_VIEW);
    render(await open());
    expect(mocks.page).toHaveBeenLastCalledWith(expect.objectContaining({ waitingPeriodDays: 14 }));
  });

  it('shows no customer without the view key', async () => {
    as(DELETE);
    render(await open());
    expect(mocks.page).not.toHaveBeenCalled();
    expect(screen.getByText(/You don't have access to customers/)).toBeTruthy();
  });
});
