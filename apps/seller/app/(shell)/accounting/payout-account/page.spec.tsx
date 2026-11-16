import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Payout account under Accounting: the seller shell with the menu's Payout account item active,
// a titled banner when only the data fails, and the Stripe way back passed to the view.

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('../../../../src/server/payout-page.ts', () => ({ loadPayoutPage: mocks.load }));
vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve((key: string, values?: { page?: string }) =>
      values?.page === undefined ? key : `${key}[${values.page}]`,
    ),
}));
vi.mock('../../../../src/server/seller-shell.tsx', () => ({
  SellerShell: ({
    children,
    title,
    activeId,
  }: {
    children: React.ReactNode;
    title: string;
    activeId: string;
  }) => (
    <main data-title={title} data-active={activeId}>
      {children}
    </main>
  ),
}));
vi.mock('../../../../src/payout/payout-account.tsx', () => ({
  PayoutAccountView: ({ canManage, back }: { canManage: boolean; back: string | null }) => (
    <section data-manage={String(canManage)} data-back={String(back)} />
  ),
}));

import PayoutAccountPage from './page.tsx';

const session = {
  sellerAccessState: 'approved',
  permissionKeys: ['payments.payout-account.view'],
  csrfToken: 'csrf',
};

function render(stripe?: string) {
  return PayoutAccountPage({
    searchParams: Promise.resolve(stripe === undefined ? {} : { stripe }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Payout account page', () => {
  it('shows the account in the seller shell with Payout account active', async () => {
    mocks.load.mockResolvedValue({ kind: 'ok', session, account: {} });
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('data-active="s_payout"');
    expect(html).toContain('data-title="payout.title"');
    expect(html).toContain('data-manage="false"');
    expect(html).toContain('data-back="null"');
  });

  it('passes the Stripe way back, and nothing else from the address', async () => {
    mocks.load.mockResolvedValue({
      kind: 'ok',
      session: {
        ...session,
        permissionKeys: [...session.permissionKeys, 'payments.payout-account.manage'],
      },
      account: {},
    });
    expect(renderToStaticMarkup(await render('return'))).toContain('data-back="return"');
    expect(renderToStaticMarkup(await render('refresh'))).toContain('data-manage="true"');
    expect(renderToStaticMarkup(await render('<b>x</b>'))).toContain('data-back="null"');
  });

  it('keeps the shell around a titled banner when only the data failed', async () => {
    mocks.load.mockResolvedValue({ kind: 'unavailable', session });
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('data-active="s_payout"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('settings.load-error.title[payout.title]');
  });

  it('falls back to the plain error when the session itself is unavailable', async () => {
    mocks.load.mockResolvedValue({ kind: 'unavailable' });
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('identity.error.unknown');
    expect(html).not.toContain('data-active');
  });

  it('says what is missing when the role cannot view payouts', async () => {
    mocks.load.mockResolvedValue({ kind: 'no-access', session });
    const html = renderToStaticMarkup(await render());
    expect(html).toContain('data-active="s_payout"');
    expect(html).toContain('payout.no-access.title');
    expect(html).toContain('payout.no-access.body');
  });
});
