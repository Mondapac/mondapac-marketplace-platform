// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../messages/en.json';
import type { AdminSession } from '../../../../../src/server/session.ts';
import SecurityAlertPage from './page.tsx';

const mocks = vi.hoisted(() => ({ get: vi.fn(), session: vi.fn(), detail: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('../../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
// The frame's parts are async server components; the page's own choices are what is tested here.
vi.mock('../../../../../src/security-centre/frame.tsx', () => ({
  SecurityFrame: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
  SecurityNoAccess: () => <p>no-access</p>,
  SecurityUnavailable: ({ message }: { readonly message: string }) => <p>{message}</p>,
}));
vi.mock('../../../../../src/security-centre/alert-detail.tsx', () => ({
  AlertDetailView: (props: unknown) => {
    mocks.detail(props);
    return <div>detail</div>;
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
      timezone: null,
      marketTimezone: 'Australia/Brisbane',
      locale: null,
      email: 'ada@example.test',
      displayName: 'Ada',
      csrfToken: 'c',
    } satisfies AdminSession,
  });
const AID = '0190a000-0000-7000-8000-0000000000a1';
const open = (alertId = AID) => SecurityAlertPage({ params: Promise.resolve({ alertId }) });
const props = () =>
  mocks.detail.mock.calls[0]?.[0] as {
    canRespond: boolean;
    resolvers: unknown;
    zone: string;
    maxSteps: number;
  };
const ALERT = { kind: 'ok', body: { id: 'abc', title: 'Alert' } };
const ROSTER = {
  kind: 'ok',
  body: {
    configured: true,
    incidentCommander: { code: 'ali', name: 'Ali K.' },
    securityOwner: { code: 'hassan', name: 'Hassan R.' },
    escalationMaxSteps: 12,
  },
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('security alert page', () => {
  it('reads nothing without security.centre.view', async () => {
    as('security.alerts.respond');
    render(await open());
    expect(screen.getByText('no-access')).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('names the resolvers from the roster and lets a responder act', async () => {
    as('security.centre.view', 'security.alerts.respond');
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.includes('alerts/') ? ALERT : ROSTER),
    );
    render(await open());
    expect(mocks.get).toHaveBeenCalledWith(`security/admin/alerts/${AID}`);
    expect(props()).toMatchObject({
      canRespond: true,
      resolvers: { commander: 'Ali K.', owner: 'Hassan R.' },
      zone: 'Australia/Brisbane',
      maxSteps: 12,
    });
  });

  it('treats no roster as no resolvers, and a failed roster read as unnamed ones', async () => {
    as('security.centre.view');
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('alerts/')
          ? ALERT
          : { kind: 'ok', body: { ...ROSTER.body, configured: false } },
      ),
    );
    render(await open());
    expect(props()).toMatchObject({ canRespond: false, resolvers: null });
    cleanup();
    vi.clearAllMocks();
    as('security.centre.view');
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.includes('alerts/') ? ALERT : { kind: 'unavailable' }),
    );
    render(await open());
    expect(props().resolvers).toEqual({ commander: null, owner: null });
  });

  it('says the alert is not in this Market on a 404', async () => {
    as('security.centre.view');
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.includes('alerts/') ? { kind: 'not-found' } : ROSTER),
    );
    render(await open());
    expect(screen.getByText('Alert not found')).toBeTruthy();
  });

  it('reads nothing for an id that is not an alert id, such as ..', async () => {
    as('security.centre.view');
    for (const bad of ['..', '%2e%2e', 'nope/../x']) {
      render(await open(bad));
      expect(screen.getByText('Alert not found')).toBeTruthy();
      cleanup();
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
