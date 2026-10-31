import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Payout account and Stock locations: when only the data fails to load, the page keeps its settings
// shell (sub-navigation, breadcrumb, title) around a titled critical banner, as Store profile does.

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  serverGet: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('./session.ts', () => ({ requireSession: mocks.requireSession }));
vi.mock('./server-fetch.ts', () => ({ serverGet: mocks.serverGet }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve((key: string, values?: { page?: string }) =>
      values?.page === undefined ? key : `${key}[${values.page}]`,
    ),
}));
vi.mock('./settings-shell.tsx', () => ({
  SettingsShell: ({
    children,
    title,
    linkId,
  }: {
    children: React.ReactNode;
    title: string;
    linkId: string;
  }) => (
    <main data-title={title} data-link={linkId}>
      {children}
    </main>
  ),
}));
vi.mock('../payout/payout-account.tsx', () => ({ PayoutAccountView: () => <section /> }));
vi.mock('../stock/stock-locations.tsx', () => ({ StockLocations: () => <section /> }));

import PayoutAccountPage from '../../app/(shell)/settings/payout-account/page.tsx';
import StockLocationsPage from '../../app/(shell)/settings/stock-locations/page.tsx';
import { loadPayoutPage } from './payout-page.ts';
import { loadStockPage } from './stock-page.ts';

const session = {
  sellerAccessState: 'approved',
  permissionKeys: ['payments.payout-account.view', 'inventory.stock.view'],
  csrfToken: 'csrf',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ kind: 'ok', session });
  mocks.serverGet.mockResolvedValue({ kind: 'unavailable' });
});

describe.each([
  [
    'Payout account',
    'payout-account',
    'payout.title',
    loadPayoutPage,
    () => PayoutAccountPage({ searchParams: Promise.resolve({}) }),
  ],
  ['Stock locations', 'stock-locations', 'stock.title', loadStockPage, () => StockLocationsPage()],
] as const)('%s load error', (_name, link, title, load, render) => {
  it('keeps the session in the unavailable answer when only the data failed', async () => {
    expect(await load()).toEqual({
      kind: 'unavailable',
      session: expect.objectContaining({ csrfToken: 'csrf' }) as unknown,
    });
  });

  it('renders a titled critical banner inside the settings shell', async () => {
    const html = renderToStaticMarkup(await render());

    expect(html).toContain(`data-link="${link}"`);
    expect(html).toContain(`data-title="${title}"`);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`settings.load-error.title[${title}]`);
    expect(html).toContain('settings.load-error.body');
    expect(html).toContain('load.retry');
  });

  it('falls back to the plain error when the session itself is unavailable', async () => {
    mocks.requireSession.mockResolvedValue({ kind: 'unavailable' });

    const html = renderToStaticMarkup(await render());

    expect(html).toContain('identity.error.unknown');
    expect(html).not.toContain('data-title');
  });
});
