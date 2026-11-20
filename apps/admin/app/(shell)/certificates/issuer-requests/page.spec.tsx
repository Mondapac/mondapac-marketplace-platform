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
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../../../../src/certificates/tabs.tsx', () => ({ CertificatesTabs: () => null }));
vi.mock('../../../../src/certificates/requests/requests-list.tsx', () => ({
  RequestsList: (props: {
    paging: string;
    zone: string;
    sellerId: string | null;
    typeNames: Record<string, string>;
  }) => (
    <p>{`list ${props.paging} ${props.zone} ${props.sellerId ?? 'no-seller'} ${props.typeNames['halal'] ?? 'no names'}`}</p>
  ),
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
const search = (values: Record<string, string> = {}) => ({ searchParams: Promise.resolve(values) });
const SELLER = '0190a000-0000-7000-8000-0000000000B1';

/** The page's own reads: the paging setting and, when asked, the types. */
function serve(paging: unknown, types: unknown = { kind: 'unavailable' }) {
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(
      path === 'settings/admin/list-paging'
        ? paging
        : path.startsWith('certification/admin/types')
          ? types
          : { kind: 'unavailable' },
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  serve({ kind: 'ok', body: { listPaging: 'pages' } });
});
afterEach(cleanup);

describe('issuer requests page', () => {
  it('reads nothing without the issuer view permission', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await IssuerRequestsPage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText(messages.certificates.requests['no-access'])).toBeTruthy();
    expect(screen.queryByText(/^list /)).toBeNull();
  });

  it('hands the list the Market paging mode and the zone, and reads no requests itself', async () => {
    render(await IssuerRequestsPage(search()));
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
    expect(screen.getByText('list pages Australia/Brisbane no-seller no names')).toBeTruthy();
  });

  it('falls back to Previous and next when the setting cannot be read or is not pages', async () => {
    serve({ kind: 'unavailable' });
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(/^list prev-next /)).toBeTruthy();
    cleanup();
    serve({ kind: 'ok', body: { listPaging: 'prev-next' } });
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(/^list prev-next /)).toBeTruthy();
  });

  it('names the types only for a reader who may view them', async () => {
    mocks.session.mockResolvedValue({
      kind: 'ok',
      session: session([VIEW, 'certification.type.view']),
    });
    serve(
      { kind: 'ok', body: { listPaging: 'pages' } },
      { kind: 'ok', body: { items: [{ code: 'halal', names: { en: 'Halal' } }] } },
    );
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(/ Halal$/)).toBeTruthy();
    cleanup();
    serve({ kind: 'ok', body: { listPaging: 'pages' } }, { kind: 'unavailable' });
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(/ no names$/)).toBeTruthy();
  });

  it('passes a seller link on as a lower-case id, and ignores anything else', async () => {
    render(await IssuerRequestsPage(search({ sellerId: SELLER })));
    expect(screen.getByText(new RegExp(` ${SELLER.toLowerCase()} `))).toBeTruthy();
    cleanup();
    render(await IssuerRequestsPage(search({ sellerId: 'not-an-id' })));
    expect(screen.getByText(/ no-seller /)).toBeTruthy();
  });

  it('says a request was answered, for the flag only', async () => {
    render(await IssuerRequestsPage(search({ answered: '1' })));
    expect(screen.getByText('Request answered. The seller gets an email.')).toBeTruthy();
    cleanup();
    render(await IssuerRequestsPage(search({ answered: 'yes' })));
    expect(screen.queryByText(/Request answered/)).toBeNull();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await IssuerRequestsPage(search()));
    expect(screen.getByText(messages.identity.error.unknown)).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
