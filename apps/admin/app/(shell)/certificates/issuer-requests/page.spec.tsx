// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import IssuerRequestsPage from './page.tsx';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../../src/certificates/tabs.tsx', () => ({ CertificatesTabs: () => null }));
vi.mock('../../../../src/certificates/requests/requests-table.tsx', () => ({
  RequestsTable: ({
    rows,
    typeNames,
  }: {
    rows: readonly unknown[];
    typeNames: ReadonlyMap<string, string>;
  }) => <p>{`${rows.length} rows, ${typeNames.get('halal') ?? 'no names'}`}</p>,
}));

const VIEW = 'certification.issuer.view';
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
  marketTimezone: 'Australia/Brisbane',
  csrfToken: 'c',
});
const CURSOR = '0190a000-0000-7000-8000-0000000000e1';
const search = (values: Record<string, string> = {}) => ({ searchParams: Promise.resolve(values) });
const page = (next: string | null = null) => ({
  kind: 'ok',
  body: { items: [{}], nextAfterId: next, total: 1 },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue(page());
});
afterEach(cleanup);

describe('issuer requests page', () => {
  it('reads nothing without the issuer view permission', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await IssuerRequestsPage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.requests['no-access'])).toBeTruthy();
  });

  it('reads the queue and uses only a UUID cursor', async () => {
    render(await IssuerRequestsPage(search({ after: 'not-a-uuid' })));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('certification/admin/issuer-requests?limit=25');
    expect(screen.getByText('1 rows, no names')).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValue(page('0190a000-0000-7000-8000-0000000000e2'));
    render(await IssuerRequestsPage(search({ after: CURSOR })));
    expect(mocks.get).toHaveBeenLastCalledWith(
      `certification/admin/issuer-requests?limit=25&afterId=${CURSOR}`,
    );
    expect(screen.getByRole('link', { name: 'Next page' }).getAttribute('href')).toContain(
      '?after=',
    );
    expect(screen.getByRole('link', { name: 'First page' })).toBeTruthy();
  });

  it('names the types only for a reader who may view them', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([VIEW, 'certification.type.view']),
    });
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('certification/admin/types')
          ? { kind: 'ok', body: { items: [{ code: 'halal', names: { en: 'Halal' } }] } }
          : page(),
      ),
    );
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText('1 rows, Halal')).toBeTruthy();
    cleanup();
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('certification/admin/types') ? { kind: 'unavailable' } : page(),
      ),
    );
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText('1 rows, no names')).toBeTruthy();
    expect(screen.getByText('1 request is open, oldest first.')).toBeTruthy();
  });

  it('says a request was answered, for the flag only', async () => {
    render(await IssuerRequestsPage(search({ answered: '1' })));
    expect(screen.getByText('Request answered. The seller gets an email.')).toBeTruthy();
    cleanup();
    render(await IssuerRequestsPage(search({ answered: 'yes' })));
    expect(screen.queryByText(/Request answered/)).toBeNull();
  });

  it('handles refused, unavailable and signed-out reads', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'forbidden' });
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(messages.certificates.requests['no-access'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(messages.certificates.requests.unavailable)).toBeTruthy();
    mocks.get.mockResolvedValueOnce({ kind: 'signed-out' });
    await expect(IssuerRequestsPage(search())).rejects.toThrow('redirect:/session-ended');
  });
});
