// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import AccountDeletionPage from './page.tsx';
import RequestsPage from './requests/page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  panel: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/settings-shell.tsx', () => ({
  SettingsShell: ({
    children,
    linkId,
    nested,
  }: {
    readonly children: ReactNode;
    readonly linkId: string;
    readonly nested?: boolean;
  }) => (
    <main data-link={linkId} data-nested={nested === true ? 'yes' : 'no'}>
      {children}
    </main>
  ),
}));
vi.mock('../../../../src/account-deletion/settings-panel.tsx', () => ({
  AccountDeletionSettingsPanel: (props: unknown) => {
    mocks.panel(props);
    return <div>panel</div>;
  },
}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/account-deletion/requests-list.tsx', () => ({
  RequestsList: (props: {
    readonly initialView: string;
    readonly paging: string;
    readonly marketId: string;
    readonly csrfToken: string;
    readonly accountId: string;
    readonly zone: string;
  }) => (
    <div
      data-list=""
      data-view={props.initialView}
      data-paging={props.paging}
      data-market={props.marketId}
      data-csrf={props.csrfToken}
      data-account={props.accountId}
      data-zone={props.zone}
    >
      the list
    </div>
  ),
}));

const SETTINGS_VIEW = 'customers.account-deletion-settings.view';
const SETTINGS_MANAGE = 'customers.account-deletion-settings.manage';
const REQUESTS_VIEW = 'customers.account-deletion-requests.view';
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
const as = (...keys: string[]) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });
const settings = {
  kind: 'ok',
  body: { version: 1, settings: { enabled: false, waitingPeriodDays: 30 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(settings);
});
afterEach(cleanup);

describe('settings account deletion page', () => {
  it('shows no-access without the view key and reads nothing', async () => {
    as();
    render(await AccountDeletionPage());
    expect(
      screen.getByText(
        /needs the permission "View account deletion"\. An admin who manages roles can add it\./,
      ),
    ).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('sits on the settings template as the account-deletion page of the map', async () => {
    as(SETTINGS_VIEW);
    const { container } = render(await AccountDeletionPage());
    const main = container.querySelector('main');
    expect(main?.getAttribute('data-link')).toBe('account-deletion');
    expect(main?.getAttribute('data-nested')).toBe('no');
  });

  it('reads the setting, and the pending list only with the requests view key', async () => {
    as(SETTINGS_VIEW);
    render(await AccountDeletionPage());
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.panel.mock.calls[0]?.[0]).toMatchObject({
      canManage: false,
      pending: { state: 'hidden' },
    });
  });

  it('counts the pending list for a holder of the requests key, and passes manage', async () => {
    as(SETTINGS_VIEW, SETTINGS_MANAGE, REQUESTS_VIEW);
    mocks.get.mockResolvedValueOnce(settings).mockResolvedValueOnce({
      kind: 'ok',
      body: { entries: [{}, {}], nextCursor: 'x' },
    });
    render(await AccountDeletionPage());
    expect(mocks.get).toHaveBeenLastCalledWith('customers/admin/deletion-requests?limit=100');
    expect(mocks.panel.mock.calls[0]?.[0]).toMatchObject({
      canManage: true,
      pending: { state: 'ok', count: 2, more: true },
    });
  });

  it('shows a load error when the setting cannot be read', async () => {
    as(SETTINGS_VIEW);
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await AccountDeletionPage());
    expect(screen.getByText(/could not be loaded$/)).toBeTruthy();
    expect(
      screen.getByText('Try again. If it keeps happening, check the status page.'),
    ).toBeTruthy();
  });

  it('sends a signed-out read to session-ended', async () => {
    as(SETTINGS_VIEW);
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(AccountDeletionPage()).rejects.toThrow('redirect:/session-ended');
  });
});

describe('deletion requests page', () => {
  const search = (view?: string) => ({ searchParams: Promise.resolve({ view }) });
  const list = () => document.querySelector('[data-list]');

  it('shows no-access without the requests view key, and reads nothing', async () => {
    as(SETTINGS_VIEW);
    render(await RequestsPage(search()));
    expect(
      screen.getByText(/needs the permission "View account deletion requests"\./),
    ).toBeTruthy();
    expect(screen.queryByText('the list')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('is a nested sub-page of Account deletion, with a way back to it', async () => {
    as(REQUESTS_VIEW);
    const { container } = render(await RequestsPage(search()));
    const main = container.querySelector('main');
    expect(main?.getAttribute('data-link')).toBe('account-deletion');
    expect(main?.getAttribute('data-nested')).toBe('yes');
    expect(screen.getByRole('link', { name: 'Account deletion' }).getAttribute('href')).toBe(
      '/settings/account-deletion',
    );
    expect(screen.getByRole('heading', { name: 'Account deletion requests' })).toBeTruthy();
  });

  it('hands the list the Market paging, market, zone and viewer; Waiting is the default view', async () => {
    as(REQUESTS_VIEW);
    mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
    render(await RequestsPage(search()));
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
    expect(list()?.getAttribute('data-view')).toBe('pending');
    expect(list()?.getAttribute('data-paging')).toBe('pages');
    expect(list()?.getAttribute('data-market')).toBe('AU');
    expect(list()?.getAttribute('data-csrf')).toBe('c');
    expect(list()?.getAttribute('data-account')).toBe('a');
    // No zone of its own: the Market's.
    expect(list()?.getAttribute('data-zone')).toBe('UTC');
  });

  it('opens the view of the link, and an unknown one as Waiting', async () => {
    as(REQUESTS_VIEW);
    render(await RequestsPage(search('completed')));
    expect(list()?.getAttribute('data-view')).toBe('completed');
    cleanup();
    render(await RequestsPage(search('everything')));
    expect(list()?.getAttribute('data-view')).toBe('pending');
  });

  it('uses Previous and next when the List paging setting cannot be read', async () => {
    as(REQUESTS_VIEW);
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await RequestsPage(search()));
    expect(list()?.getAttribute('data-paging')).toBe('prev-next');
  });

  it('shows the way to retry when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await RequestsPage(search()));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
