// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { Toaster } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { CustomersList } from './customers-list.tsx';
import { AttributionsList } from './attributions-list.tsx';
import {
  attributionFiltersOfApi,
  attributionSelectorOf,
  DEFAULT_ATTRIBUTION_QUERY,
  type AttributionRow,
  type AttributionsPage,
} from './attributions-types.ts';
import { apiFilters, filtersOfApi } from './list-types.ts';
import { SellerCustomersTab } from './seller-customers-tab.tsx';
import {
  sellerBodyOf,
  DEFAULT_SELLER_QUERY,
  type SellerCustomerRow,
  type SellerCustomersPage,
  type SellerCustomersSummary,
} from './seller-customers-types.ts';

// Customers management phases 3 and 4a in the admin panel: the seller's Customers tab and the
// suspicious attributions list. Two Markets: AUD and JPY (no decimals), and no Market is assumed.

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      {node}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </StepUpProvider>
  </NextIntlClientProvider>
);
const ok = <T,>(body: T, status = 200): ApiResult<T> => ({ ok: true, status, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const SELLER = '0190a000-0000-7000-8000-0000000000e1';
const SELLER_B = '0190a000-0000-7000-8000-0000000000e2';
const A1 = '0190a000-0000-7000-8000-0000000000a1';
const A2 = '0190a000-0000-7000-8000-0000000000a2';
const VIEW = 'customers.customers.view';
const MANAGE = 'customers.seller-attributions.manage';

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const bodiesTo = (path: string) =>
  call.mock.calls.filter((args) => args[1] === path).map((args) => args[2]);

const summary = (): SellerCustomersSummary => ({
  counts: { all: 40, buyers: 25, followers: 30, referred: 7 },
  zone: 'Pacific/Auckland',
  months: [
    { month: '2026-09', newBuyers: 3, newFollowers: 5, newExclusive: 2 },
    { month: '2026-10', newBuyers: 4, newFollowers: 2, newExclusive: 1 },
  ],
});
const customerRow = (over: Partial<SellerCustomerRow> = {}): SellerCustomerRow => ({
  accountId: A1,
  code: 'K7QM-2DXP',
  firstName: 'Sara',
  orderCount: 2,
  firstOrderAt: '2026-09-02T00:00:00.000Z',
  lastOrderAt: '2026-10-02T00:00:00.000Z',
  spentMinor: '123456',
  currency: 'AUD',
  follower: true,
  followedAt: '2026-09-01T00:00:00.000Z',
  exclusive: true,
  since: '2026-09-01T00:00:00.000Z',
  ...over,
});
const customersPage = (items: readonly SellerCustomerRow[]): SellerCustomersPage => ({
  items,
  counts: { all: 40, buyers: 25, followers: 30, referred: 7 },
  paging: { total: items.length, page: 1, pageSize: 25, maxRows: 10_000 },
  nextCursor: null,
});

function routeSeller(rows: readonly SellerCustomerRow[]) {
  call.mockImplementation((_method, path) => {
    if (path.endsWith('/customers/summary')) return Promise.resolve(ok(summary()));
    if (path.endsWith('/customers/list')) return Promise.resolve(ok(customersPage(rows)));
    return Promise.resolve(refused(404, 'not-found'));
  });
}
const tabProps = {
  sellerId: SELLER,
  accountId: 'admin-1',
  marketId: 'AU',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  csrfToken: 'csrf',
};

describe('the seller Customers tab', () => {
  it('shows the four tiles with the exclusive count and the trend as a table on request', async () => {
    routeSeller([customerRow()]);
    render(wrap(<SellerCustomersTab {...tabProps} />));
    const tiles = await screen.findByRole('list', { name: 'Customer counts' });
    expect(within(tiles).getByText('Exclusive').nextElementSibling?.textContent).toBe('7');
    expect(within(tiles).getByText('Buyers').nextElementSibling?.textContent).toBe('25');
    expect(screen.getByText('Months in Pacific/Auckland')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table', {
      name: 'New buyers, new followers and new exclusive customers by month',
    });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(
      within(table).getByRole('columnheader', { name: 'New exclusive customers' }),
    ).toBeTruthy();
    const cells = within(within(table).getAllByRole('row')[1]!).getAllByRole('cell');
    expect(cells.map((c) => c.textContent)).toEqual(['3', '5', '2']);
    expect(screen.getByRole('button', { name: 'Show as chart' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows the error state when a month has no newExclusive', async () => {
    call.mockImplementation((_method, path) => {
      if (path.endsWith('/customers/summary')) {
        const bad = summary() as unknown as { months: Record<string, unknown>[] };
        delete bad.months[0]!.newExclusive;
        return Promise.resolve(ok(bad));
      }
      return Promise.resolve(ok(customersPage([])));
    });
    render(wrap(<SellerCustomersTab {...tabProps} />));
    expect(await screen.findByText('The summary could not be loaded. Try again.')).toBeTruthy();
  });

  it('lists the customers with the code, money from the API and a link to the customer page', async () => {
    routeSeller([
      customerRow(),
      customerRow({ accountId: A2, code: 'AB12-CD34', currency: 'JPY', spentMinor: '5000' }),
    ]);
    render(wrap(<SellerCustomersTab {...tabProps} />));
    const link = await screen.findByRole('link', { name: 'K7QM-2DXP' });
    expect(link.getAttribute('href')).toBe(`/customers/${A1}`);
    expect(screen.getByText(/1,234\.56/)).toBeTruthy();
    expect(screen.getByText(/5,000/)).toBeTruthy();
    expect(bodiesTo(`customers/admin/sellers/${SELLER}/customers/list`)[0]).toMatchObject({
      view: 'all',
      sort: 'last-order',
      direction: 'desc',
      page: 1,
      pageSize: 25,
    });
  });

  it('says why a search is not sent and sends the next view when a tab is chosen', async () => {
    routeSeller([customerRow()]);
    render(wrap(<SellerCustomersTab {...tabProps} />));
    await screen.findByRole('link', { name: 'K7QM-2DXP' });
    fireEvent.click(screen.getByRole('button', { name: /Referred/ }));
    await waitFor(() =>
      expect(
        bodiesTo(`customers/admin/sellers/${SELLER}/customers/list`).some(
          (body) => (body as { view: string }).view === 'referred',
        ),
      ).toBe(true),
    );
  });

  it('hides the whole tab on 403 and shows a retry on another failure', async () => {
    call.mockResolvedValue(refused(403, 'access.denied'));
    render(wrap(<SellerCustomersTab {...tabProps} />));
    expect(await screen.findByText(/don’t have access to this seller’s customers/)).toBeTruthy();
    cleanup();
    call.mockImplementation((_m, path) =>
      Promise.resolve(
        path.endsWith('/summary')
          ? refused(429, 'rate-limited', { retryAfterSeconds: 300 })
          : ok(customersPage([])),
      ),
    );
    render(wrap(<SellerCustomersTab {...tabProps} />));
    expect(await screen.findByText('Try again in 5 minutes.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
  });

  it('builds the request body with minor units and without a short code search', () => {
    expect(
      sellerBodyOf({
        ...DEFAULT_SELLER_QUERY,
        q: 'k',
        filters: { follower: 'yes', spentMin: '1000', ordersMin: '2' },
      }),
    ).toEqual({
      view: 'all',
      filters: { follower: true, spentMin: '1000', ordersMin: 2 },
      sort: 'last-order',
      direction: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(sellerBodyOf({ ...DEFAULT_SELLER_QUERY, q: 'k7-qm' }).q).toBe('k7qm');
  });
});

const attribution = (over: Partial<AttributionRow> = {}): AttributionRow => ({
  accountId: A1,
  email: 'sara@example.com',
  displayName: 'Sara Ahmadi',
  sellerId: SELLER,
  attributedAt: '2026-11-10T03:00:00.000Z',
  status: 'active',
  rejectReason: null,
  flags: ['link-burst'],
  decidedAt: null,
  ...over,
});
const attributionsPage = (items: readonly AttributionRow[]): AttributionsPage => ({
  items,
  counts: { suspicious: 2, all: 5, active: 3, rejected: 2 },
  paging: { total: items.length, page: 1, pageSize: 25, maxRows: 10_000 },
  nextCursor: null,
});
const listProps = {
  accountId: 'admin-1',
  marketId: 'NZ',
  zone: 'Pacific/Auckland',
  paging: 'pages' as const,
  csrfToken: 'csrf',
};

function routeAttributions(
  items: readonly AttributionRow[],
  decide?: () => Promise<ApiResult<unknown>>,
) {
  call.mockImplementation((_method, path) => {
    if (path === 'customers/admin/seller-attributions/list') {
      return Promise.resolve(ok(attributionsPage(items)));
    }
    if (path.startsWith('customers/admin/saved-filters')) {
      return Promise.resolve(
        ok({ items: [], canShare: false, limits: { perOwner: 50, shared: 20 } }),
      );
    }
    if (path === 'sellers/admin/list') {
      return Promise.resolve(
        ok({ items: [{ sellerId: SELLER, storeName: 'Halal Bites' }], next: null }),
      );
    }
    if (path === 'customers/admin/seller-attributions/decide' && decide !== undefined) {
      return decide();
    }
    return Promise.resolve(refused(404, 'not-found'));
  });
}

describe('the suspicious attributions list', () => {
  it('opens on Suspicious, names the seller and shows the status and flag as text', async () => {
    routeAttributions([
      attribution(),
      attribution({
        accountId: A2,
        email: 'b@example.com',
        displayName: null,
        status: 'rejected',
        rejectReason: 'seller-team',
        flags: [],
        decidedAt: '2026-11-11T03:00:00.000Z',
      }),
    ]);
    render(
      wrap(
        <AttributionsList {...listProps} permissionKeys={[VIEW, MANAGE, 'sellers.seller.view']} />,
      ),
    );
    expect(
      (await screen.findAllByRole('link', { name: 'Halal Bites' }))[0]?.getAttribute('href'),
    ).toBe(`/sellers/${SELLER}`);
    expect(bodiesTo('customers/admin/seller-attributions/list')[0]).toMatchObject({
      view: 'suspicious',
      direction: 'desc',
    });
    expect(screen.getByRole('button', { name: /Suspicious \(2\)/ })).toBeTruthy();
    expect(screen.getByText('Link burst')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sara Ahmadi' }).getAttribute('href')).toBe(
      `/customers/${A1}`,
    );
  });

  it('disables Restore with its reason for a seller-team rejection', async () => {
    routeAttributions([
      attribution({ status: 'rejected', rejectReason: 'seller-team', flags: [] }),
    ]);
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW, MANAGE]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Sara Ahmadi' }));
    const item = await screen.findByRole('menuitem', { name: /Restore…/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/Not restorable: seller’s team/)).toBeTruthy();
  });

  it('hides Reject and Restore without the manage key', async () => {
    routeAttributions([attribution()]);
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Sara Ahmadi' }));
    await screen.findByRole('menuitem', { name: 'Open customer' });
    expect(screen.queryByRole('menuitem', { name: /Reject…/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bulk action' })).toBeNull();
  });

  it('rejects after a level 2 confirm that says placed orders keep their terms, then shows the result', async () => {
    routeAttributions([attribution()], () =>
      Promise.resolve(ok({ results: [{ accountId: A1, outcome: 'changed', status: 'rejected' }] })),
    );
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW, MANAGE]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Sara Ahmadi' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reject…/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Orders already placed keep their terms/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(bodiesTo('customers/admin/seller-attributions/decide')[0]).toEqual({
        decision: 'reject',
        accountIds: [A1],
      }),
    );
    expect(await screen.findByText('1 attribution rejected')).toBeTruthy();
  });

  it('keeps the dialog open with a message on a concurrent decision', async () => {
    routeAttributions([attribution()], () =>
      Promise.resolve(refused(503, 'customers.unavailable')),
    );
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW, MANAGE]} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Sara Ahmadi' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Reject…/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Another change is in progress. Try again.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the section as no access on 403 and the empty line for an empty Suspicious view', async () => {
    call.mockImplementation((_m, path) =>
      Promise.resolve(
        path === 'customers/admin/seller-attributions/list'
          ? refused(403, 'access.denied')
          : refused(404, 'x'),
      ),
    );
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('You don’t have access to customers.')).toBeTruthy();
    cleanup();
    routeAttributions([]);
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('No suspicious attributions.')).toBeTruthy();
  });

  it('keeps the selector and the saved-filter shape of the API', () => {
    const query = {
      ...DEFAULT_ATTRIBUTION_QUERY,
      q: 'sa',
      filters: { sellerId: SELLER_B, flag: 'link-burst' as const, attributedFrom: '2026-11-01' },
    };
    expect(attributionSelectorOf(query)).toEqual({
      view: 'suspicious',
      q: 'sa',
      filters: { sellerId: SELLER_B, flag: 'link-burst', attributedFrom: '2026-11-01' },
    });
    expect(attributionFiltersOfApi({ sellerId: 'x', status: 'nope', flag: 'link-burst' })).toEqual({
      flag: 'link-burst',
    });
  });
});

describe('the Store followed filter of the Customers list', () => {
  it('is sent as followsSellerId and read back from a saved filter', () => {
    expect(apiFilters({ follows: SELLER })).toEqual({ followsSellerId: SELLER });
    expect(filtersOfApi({ followsSellerId: SELLER.toUpperCase() })).toEqual({ follows: SELLER });
    expect(filtersOfApi({ followsSellerId: 'shop-1' })).toEqual({});
  });
});

describe('review fixes', () => {
  const savedAnswer = (canShare: boolean) =>
    ok({ items: [], canShare, limits: { perOwner: 50, shared: 20 } });
  const route = (canShare: boolean) =>
    call.mockImplementation((_m, path) => {
      if (path === 'customers/admin/seller-attributions/list') {
        return Promise.resolve(ok(attributionsPage([attribution()])));
      }
      if (path.startsWith('customers/admin/saved-filters') && _m === 'GET') {
        return Promise.resolve(savedAnswer(canShare));
      }
      if (path === 'customers/admin/saved-filters') {
        return Promise.resolve(refused(500, 'x'));
      }
      return Promise.resolve(ok({ items: [], next: null }));
    });

  async function saveWith(visibility: 'Everyone' | 'Only me') {
    route(true);
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW]} />));
    const search = await screen.findByLabelText('Search attributions');
    fireEvent.change(search, { target: { value: 'sara@' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: /Save filter…/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(visibility) }));
    return dialog;
  }
  const savedBody = () =>
    call.mock.calls.find(
      (args) => args[0] === 'POST' && args[1] === 'customers/admin/saved-filters',
    )?.[2] as {
      payload: { q?: string };
    };

  it('leaves the search term out of a filter shared with everyone, and says so', async () => {
    const dialog = await saveWith('Everyone');
    expect(within(dialog).getByText(/search term is not kept in a shared filter/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(savedBody()).toBeTruthy());
    expect(savedBody().payload.q).toBeUndefined();
  });

  it('keeps the search term in a personal filter', async () => {
    const dialog = await saveWith('Only me');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(savedBody()).toBeTruthy());
    expect(savedBody().payload.q).toBe('sara@');
  });

  it('offers no store picker without the sellers key, and keeps an applied chip readable', async () => {
    call.mockImplementation((_m, path) =>
      Promise.resolve(
        path === 'customers/admin/list'
          ? ok({
              items: [],
              counts: {
                all: 0,
                new: 0,
                active: 0,
                inactive: 0,
                'never-ordered': 0,
                disabled: 0,
                'pending-deletion': 0,
              },
              paging: { total: 0, page: 1, pageSize: 25, maxRows: 10_000 },
              nextCursor: null,
            })
          : path.startsWith('customers/admin/saved-filters')
            ? savedAnswer(false)
            : ok({ items: [] }),
      ),
    );
    render(
      wrap(
        <CustomersList
          accountId="admin-1"
          marketId="AU"
          marketName="Australia"
          zone="Australia/Brisbane"
          paging="pages"
          permissionKeys={[VIEW]}
          csrfToken="csrf"
        />,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Filter/ }));
    expect(screen.queryByText('Store followed')).toBeNull();
    expect(call.mock.calls.some((args) => args[1] === 'sellers/admin/list')).toBe(false);
  });

  it('attributions filter panel: no picker without the sellers key, store as short id', async () => {
    route(false);
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW]} />));
    await screen.findAllByText('Sara Ahmadi');
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(await screen.findByText('UTC days', { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText('Search stores')).toBeNull();
    expect(call.mock.calls.some((args) => args[1] === 'sellers/admin/list')).toBe(false);
  });

  it('lists not-found and seller-team answers in the result dialog', async () => {
    routeAttributions(
      [attribution(), attribution({ accountId: A2, email: 'b@example.com', displayName: 'Bilal' })],
      () =>
        Promise.resolve(
          ok({
            results: [
              { accountId: A1, outcome: 'not-found', status: null },
              { accountId: A2, outcome: 'seller-team', status: 'rejected' },
            ],
          }),
        ),
    );
    render(wrap(<AttributionsList {...listProps} permissionKeys={[VIEW, MANAGE]} />));
    await screen.findAllByText('Sara Ahmadi');
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Select all/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Restore…/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }),
    );
    expect(await screen.findByText('1 was not found')).toBeTruthy();
    expect(screen.getByText('Seller’s own team: 1 cannot be restored')).toBeTruthy();
    expect(screen.getAllByText(/Seller’s own team: cannot be restored/).length).toBeGreaterThan(0);
  });

  it('hides the sub-page sections on 403 from both reads', async () => {
    call.mockResolvedValue(refused(403, 'access.denied'));
    render(wrap(<SellerCustomersTab {...tabProps} />));
    expect(await screen.findByText(/don’t have access to this seller’s customers/)).toBeTruthy();
    expect(screen.queryByText('Summary')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
