// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import { WalletPage } from '../../../../src/wallet/wallet-page.tsx';
import CreditRequestsPageRoute from './page.tsx';

// The Credit requests page: the permission gate, the view of a link (the older ?status= too), the
// Market's List paging setting, and a heading on every branch.

const mocks = vi.hoisted(() => ({ get: vi.fn(), session: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../../src/wallet/credit-requests-list.tsx', () => ({
  CreditRequestsList: (props: {
    readonly initialView: string;
    readonly paging: string;
    readonly marketId: string;
    readonly csrfToken: string;
  }) => (
    <p
      data-view={props.initialView}
      data-paging={props.paging}
      data-market={props.marketId}
      data-csrf={props.csrfToken}
    >
      the list
    </p>
  ),
}));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const VIEW = 'wallet.credit.view';
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
  csrfToken: 'csrf-1',
});
const search = (view?: string, status?: string) => ({
  searchParams: Promise.resolve({ view, status }),
});
/** The page is a WalletPage element; the frame is an async server component, so it is run here. */
const show = async (...args: Parameters<typeof CreditRequestsPageRoute>) =>
  render(
    await WalletPage(
      (await CreditRequestsPageRoute(...args)).props as Parameters<typeof WalletPage>[0],
    ),
  );
const list = () => document.querySelector('[data-view]');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue({ kind: 'ok', body: { listPaging: 'pages' } });
});
afterEach(cleanup);

describe('credit requests page', () => {
  it('shows the list to an admin who may view credit, on Pending by default', async () => {
    await show(search());
    expect(screen.getByText('the list')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Credit approvals' })).toBeTruthy();
    expect(list()?.getAttribute('data-view')).toBe('pending');
    expect(list()?.getAttribute('data-paging')).toBe('pages');
    expect(list()?.getAttribute('data-market')).toBe('AU');
    expect(list()?.getAttribute('data-csrf')).toBe('csrf-1');
    expect(mocks.get).toHaveBeenCalledWith('settings/admin/list-paging');
  });

  it('opens the view of the link, and an unknown one as Pending', async () => {
    await show(search('all'));
    expect(list()?.getAttribute('data-view')).toBe('all');
    cleanup();
    await show(search('everything'));
    expect(list()?.getAttribute('data-view')).toBe('pending');
  });

  it.each(['pending', 'decided', 'granted'])(
    'still opens the view of an older ?status=%s link',
    async (status) => {
      await show(search(undefined, status));
      expect(list()?.getAttribute('data-view')).toBe(status);
    },
  );

  it('prefers ?view= to ?status=, and ignores a status that was never a tab', async () => {
    await show(search('granted', 'decided'));
    expect(list()?.getAttribute('data-view')).toBe('granted');
    cleanup();
    await show(search(undefined, 'rejected'));
    expect(list()?.getAttribute('data-view')).toBe('pending');
  });

  it('uses Previous and next when the List paging setting cannot be read', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    await show(search());
    expect(list()?.getAttribute('data-paging')).toBe('prev-next');
  });

  it('shows no list without the view permission, but still a heading and a way back', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    await show(search());
    expect(screen.queryByText('the list')).toBeNull();
    expect(screen.getByText(messages.wallet['no-access'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Credit approvals' })).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.wallet['back-home'] })).toBeTruthy();
  });

  it('shows the way to retry when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    await show(search());
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
