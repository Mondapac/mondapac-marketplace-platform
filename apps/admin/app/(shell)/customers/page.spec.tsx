// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import CustomersPage from './page.tsx';

const mocks = vi.hoisted(() => ({ get: vi.fn(), session: vi.fn(), lookup: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../src/customers/customer-lookup.tsx', () => ({
  CustomerLookup: (props: unknown) => {
    mocks.lookup(props);
    return <div>lookup</div>;
  },
}));

const VIEW = 'identity.customer-account.view';
const DELETE = 'customers.buyer-account.delete';
const SETTINGS_VIEW = 'customers.account-deletion-settings.view';
const as = (...permissionKeys: string[]) =>
  mocks.session.mockResolvedValue({
    kind: 'ok',
    session: {
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
    } satisfies AdminSession,
  });
const props = () => mocks.lookup.mock.calls[0]?.[0] as { buyerDeletion: unknown };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    kind: 'ok',
    body: { version: 1, settings: { enabled: true, waitingPeriodDays: 14 } },
  });
});
afterEach(cleanup);

describe('customers page: delete action gating', () => {
  it('hides the action without customers.buyer-account.delete and reads no setting', async () => {
    as(VIEW, SETTINGS_VIEW);
    render(await CustomersPage());
    expect(props().buyerDeletion).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows no lookup, and no action, without the customer view key', async () => {
    as(DELETE);
    render(await CustomersPage());
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(screen.getByText(/You do not have access to customer accounts/)).toBeTruthy();
  });

  it('offers the action with the waiting period for a holder who may read the setting', async () => {
    as(VIEW, DELETE, SETTINGS_VIEW);
    render(await CustomersPage());
    expect(props().buyerDeletion).toEqual({ waitingPeriodDays: 14 });
  });

  it('offers the action without a number when the setting is not readable', async () => {
    as(VIEW, DELETE);
    render(await CustomersPage());
    expect(props().buyerDeletion).toEqual({ waitingPeriodDays: null });
    expect(mocks.get).not.toHaveBeenCalled();
    cleanup();
    as(VIEW, DELETE, SETTINGS_VIEW);
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    mocks.lookup.mockClear();
    render(await CustomersPage());
    expect(props().buyerDeletion).toEqual({ waitingPeriodDays: null });
  });
});
