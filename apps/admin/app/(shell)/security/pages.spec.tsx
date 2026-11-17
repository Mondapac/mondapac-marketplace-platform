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

  it('passes only known filters from the address, in the holder zone', async () => {
    as('security.centre.view');
    render(
      await SecurityAlertsPage({
        searchParams: Promise.resolve({ state: 'resolved', severity: 's1,s9,s3' }),
      }),
    );
    expect(mocks.list.mock.calls[0]?.[0]).toEqual({
      zone: 'Pacific/Auckland',
      initialState: 'resolved',
      initialSeverities: ['s1', 's3'],
    });
    cleanup();
    vi.clearAllMocks();
    as('security.centre.view');
    render(await SecurityAlertsPage({ searchParams: Promise.resolve({ state: 'bogus' }) }));
    expect(mocks.list.mock.calls[0]?.[0]).toMatchObject({
      initialState: 'live',
      initialSeverities: [],
    });
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
