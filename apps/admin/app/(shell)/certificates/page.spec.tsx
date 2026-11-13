// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import CertificatesPage from './page.tsx';

// The certificates page: the view gate (no API read without the queue permission), the states of
// the queue read, type names only for a reader who may view types, and paging.

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
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../src/certificates/tabs.tsx', () => ({ CertificatesTabs: () => null }));
vi.mock('../../../src/certificates/queue.tsx', () => ({
  CertificateQueue: ({
    rows,
    typeNames,
  }: {
    readonly rows: readonly unknown[];
    readonly typeNames: ReadonlyMap<string, string>;
  }) => <p>{`${rows.length} rows, ${typeNames.get('halal') ?? 'no names'}`}</p>,
}));

const VIEW = 'certification.seller-certificate.view';
const TYPES = 'certification.type.view';
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
const search = (values: Record<string, string> = {}) => ({ searchParams: Promise.resolve(values) });
const queue = (items: unknown[], nextAfterId: string | null = null) => ({
  kind: 'ok',
  body: { items, nextAfterId, total: items.length },
});
const types = { kind: 'ok', body: { items: [{ code: 'halal', names: { en: 'Halal' } }] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue(queue([{}]));
});
afterEach(cleanup);

describe('certificates page', () => {
  it('reads the queue only, and shows codes, for a reader without type.view', async () => {
    render(await CertificatesPage(search()));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('certification/admin/seller-certificates?limit=25');
    expect(screen.getByRole('heading', { level: 1, name: 'Certificates' })).toBeTruthy();
    expect(screen.getByText('1 rows, no names')).toBeTruthy();
  });

  it('names the types for a reader who may view them, and survives a failed types read', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, TYPES]) });
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith('certification/admin/types') ? types : queue([{}])),
    );
    render(await CertificatesPage(search()));
    expect(screen.getByText('1 rows, Halal')).toBeTruthy();
    cleanup();
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('certification/admin/types') ? { kind: 'unavailable' } : queue([{}]),
      ),
    );
    render(await CertificatesPage(search()));
    expect(screen.getByText('1 rows, no names')).toBeTruthy();
  });

  it('links the next page, and a first page link once past the first', async () => {
    mocks.get.mockResolvedValue(queue([{}], 'cursor-2'));
    render(await CertificatesPage(search({ after: 'cursor-1' })));
    expect(mocks.get).toHaveBeenCalledWith(
      'certification/admin/seller-certificates?limit=25&afterId=cursor-1',
    );
    expect(screen.getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      '/certificates?after=cursor-2',
    );
    expect(screen.getByRole('link', { name: 'First page' }).getAttribute('href')).toBe(
      '/certificates',
    );
  });

  it('sends a reader who may only see issuers to the issuers tab', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session(['certification.issuer.view']),
    });
    await expect(CertificatesPage(search())).rejects.toThrow('redirect:/certificates/issuers');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads nothing without the queue permission, and has a way back', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([TYPES]) });
    render(await CertificatesPage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.queue['no-access'])).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toBeTruthy();
  });

  it('treats a refused read as no access, an unavailable one as an error with a retry, and signed-out as ended', async () => {
    mocks.get.mockResolvedValueOnce({ kind: 'forbidden' });
    render(await CertificatesPage(search()));
    expect(screen.getByText(messages.certificates.queue['no-access'])).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValueOnce({ kind: 'unavailable' });
    render(await CertificatesPage(search()));
    expect(screen.getByText(messages.certificates.queue.unavailable)).toBeTruthy();
    expect(screen.getByRole('button', { name: messages.load.retry })).toBeTruthy();
    mocks.get.mockResolvedValueOnce({ kind: 'signed-out' });
    await expect(CertificatesPage(search())).rejects.toThrow('redirect:/session-ended');
  });
});
