// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import SellersNeedingALookPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn(), get: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(
      createTranslator({
        locale: 'en-AU',
        messages,
        ...(namespace === undefined ? {} : { namespace }),
      } as never),
    ),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'admin.test' })),
}));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/sellers/health-queue.tsx', () => ({
  HealthQueue: (props: { paging: string; accountId: string; marketId: string }) => (
    <div
      data-testid="health-queue"
      data-paging={props.paging}
      data-account={props.accountId}
      data-market={props.marketId}
    />
  ),
}));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

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
const signedIn = (...keys: string[]) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });

const renderPage = (page: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {page}
    </NextIntlClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the sellers that need a look page', () => {
  it('renders the super list with the Market paging mode, account and market', async () => {
    signedIn('sellers.seller.view');
    mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
    renderPage(await SellersNeedingALookPage());
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
    const list = screen.getByTestId('health-queue');
    expect(list.getAttribute('data-paging')).toBe('pages');
    expect(list.getAttribute('data-account')).toBe('a');
    expect(list.getAttribute('data-market')).toBe('AU');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('falls back to Previous and next when the paging setting cannot be read', async () => {
    signedIn('sellers.seller.view');
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    renderPage(await SellersNeedingALookPage());
    expect(screen.getByTestId('health-queue').getAttribute('data-paging')).toBe('prev-next');
  });

  it('makes no call and shows no-access without the key', async () => {
    signedIn('identity.seller-access.view');
    renderPage(await SellersNeedingALookPage());
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('health-queue')).toBeNull();
    expect(screen.getByText("You don't have access to this page")).toBeTruthy();
  });
});
