// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import SecurityAlertsPage from './alerts/page.tsx';
import SecurityOnCallPage from './on-call/page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  list: vi.fn(),
  onCall: vi.fn(),
}));

vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve('en-AU'),
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/security-centre/frame.tsx', () => ({
  SecurityFrame: ({
    children,
    tab,
  }: {
    readonly children: ReactNode;
    readonly tab: string | null;
  }) => <main data-tab={tab ?? 'none'}>{children}</main>,
  SecurityNoAccess: () => <p>no-access</p>,
  SecurityUnavailable: ({ message }: { readonly message: string }) => <p>{message}</p>,
}));
vi.mock('../../../src/security-centre/alerts-list.tsx', () => ({
  AlertsList: (props: unknown) => {
    mocks.list(props);
    return <div>list</div>;
  },
}));
vi.mock('../../../src/security-centre/on-call-view.tsx', () => ({
  OnCallView: (props: unknown) => {
    mocks.onCall(props);
    return <div>on-call</div>;
  },
}));

const as = (...permissionKeys: string[]) =>
  mocks.session.mockResolvedValue({
    kind: 'ok',
    session: {
      accountId: 'a',
      roleId: 'r',
      permissionKeys,
      secondFactorActive: true,
      lastSignInAt: null,
      timezone: 'Pacific/Auckland',
      marketTimezone: 'Australia/Brisbane',
      locale: null,
      email: 'ada@example.test',
      displayName: 'Ada',
      csrfToken: 'c',
    } satisfies AdminSession,
  });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('security alerts page', () => {
  it('shows no list without security.centre.view', async () => {
    as('security.alerts.respond');
    render(await SecurityAlertsPage({}));
    expect(screen.getByText('no-access')).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('passes the view, the severity and the Market paging setting, in the holder zone', async () => {
    mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
    as('security.centre.view');
    render(
      await SecurityAlertsPage({
        searchParams: Promise.resolve({ view: 'critical', severity: 's1' }),
      }),
    );
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
    expect(mocks.list.mock.calls[0]?.[0]).toEqual({
      zone: 'Pacific/Auckland',
      paging: 'pages',
      accountId: 'a',
      marketId: 'AU',
      csrfToken: 'c',
      initialView: 'critical',
      initialSeverity: 's1',
    });
  });

  it('maps an older state link to the nearest view, ignores unknown values, and falls back to Previous and next', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    as('security.centre.view');
    render(
      await SecurityAlertsPage({
        searchParams: Promise.resolve({ state: 'live', severity: 's1,s3' }),
      }),
    );
    expect(mocks.list.mock.calls[0]?.[0]).toMatchObject({
      paging: 'prev-next',
      initialView: 'open',
    });
    expect(mocks.list.mock.calls[0]?.[0]).not.toHaveProperty('initialSeverity');
    cleanup();
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    as('security.centre.view');
    render(await SecurityAlertsPage({ searchParams: Promise.resolve({ state: 'bogus' }) }));
    expect(mocks.list.mock.calls[0]?.[0]).not.toHaveProperty('initialView');
  });
});

describe('security on-call page', () => {
  it('reads nothing without security.centre.view', async () => {
    as();
    render(await SecurityOnCallPage());
    expect(screen.getByText('no-access')).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('shows the roster, or says it could not be read', async () => {
    as('security.centre.view');
    mocks.get.mockResolvedValueOnce({ kind: 'ok', body: { configured: false } });
    render(await SecurityOnCallPage());
    expect(mocks.get).toHaveBeenCalledWith('security/admin/on-call');
    expect(screen.getByText('on-call')).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await SecurityOnCallPage());
    expect(screen.getByText("Couldn't load the on-call view")).toBeTruthy();
  });
});
