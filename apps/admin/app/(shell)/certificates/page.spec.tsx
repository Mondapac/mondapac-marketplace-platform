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
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/certificates/queue-list/queue-list.tsx', () => ({
  QueueList: ({
    types,
    paging,
    sellerId,
    zone,
  }: {
    readonly types: readonly { readonly code: string; readonly name: string }[];
    readonly paging: string;
    readonly sellerId: string | null;
    readonly zone: string;
  }) => (
    <p>{`list ${paging} ${zone} ${sellerId ?? 'no seller'}, ${types.map((type) => type.name).join('+') || 'no names'}`}</p>
  ),
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
const paging = (listPaging: string) => ({ kind: 'ok', body: { listPaging } });
const types = { kind: 'ok', body: { items: [{ code: 'halal', names: { en: 'Halal' } }] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith('settings/admin/list-paging') ? paging('pages') : types),
  );
});
afterEach(cleanup);

describe('certificates page', () => {
  it('reads the paging setting only, and gives the list no type names, for a reader without type.view', async () => {
    render(await CertificatesPage(search()));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
    expect(screen.getByRole('heading', { level: 1, name: 'Certification' })).toBeTruthy();
    expect(screen.getByText('list pages UTC no seller, no names')).toBeTruthy();
  });

  it('falls back to Previous and next when the paging setting cannot be read', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await CertificatesPage(search()));
    expect(screen.getByText('list prev-next UTC no seller, no names')).toBeTruthy();
  });

  it('names the types for a reader who may view them, and survives a failed types read', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, TYPES]) });
    render(await CertificatesPage(search()));
    expect(mocks.get).toHaveBeenCalledWith('certification/admin/types');
    expect(screen.getByText('list pages UTC no seller, Halal')).toBeTruthy();
    cleanup();
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.startsWith('certification/admin/types') ? { kind: 'unavailable' } : paging('pages'),
      ),
    );
    render(await CertificatesPage(search()));
    expect(screen.getByText('list pages UTC no seller, no names')).toBeTruthy();
  });

  it('passes a seller from a link to the list, and ignores one that is not an id', async () => {
    const id = '0190a000-0000-7000-8000-000000000300';
    render(await CertificatesPage(search({ sellerId: id.toUpperCase() })));
    expect(screen.getByText(`list pages UTC ${id}, no names`)).toBeTruthy();
    cleanup();
    render(await CertificatesPage(search({ sellerId: 'x' })));
    expect(screen.getByText('list pages UTC no seller, no names')).toBeTruthy();
  });

  it('says a decision was recorded, for the three outcomes only', async () => {
    render(await CertificatesPage(search({ decided: 'approve' })));
    expect(screen.getByText('Certificate approved.')).toBeTruthy();
    cleanup();
    render(await CertificatesPage(search({ decided: 'decline' })));
    expect(screen.getByText('Certificate declined.')).toBeTruthy();
    cleanup();
    render(await CertificatesPage(search({ decided: '<b>x</b>' })));
    expect(screen.queryByRole('status')).toBeNull();
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

  it('sends a signed-out reader to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, TYPES]) });
    await expect(CertificatesPage(search())).rejects.toThrow('redirect:/session-ended');
  });
});
