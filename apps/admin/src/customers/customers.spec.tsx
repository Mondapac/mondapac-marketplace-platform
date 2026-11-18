// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
// The Orders tab's list keeps its query in the address (the super list kit).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/customers/x',
  useSearchParams: () => new URLSearchParams(),
}));

import { Toaster } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { backHrefOf, customerOriginOf, orderHref } from '../orders/order-href.ts';
import { CustomerPage } from './customer-page.tsx';
import { CustomersBulk } from './customers-bulk.tsx';
import { CustomersFilterPanel, majorOf } from './customers-filter-panel.tsx';
import { CustomersList } from './customers-list.tsx';
import { dayOf } from './format.ts';
import {
  DEFAULT_QUERY,
  payloadOf,
  queryOfPayload,
  selectorOf,
  type CustomerRow,
  type CustomersPage,
} from './list-types.ts';
import { averageMinor, tabsFor, type CustomerOverview } from './page-types.ts';

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

const ID = '0190a000-0000-7000-8000-0000000000a1';
const row = (over: Partial<CustomerRow> = {}): CustomerRow => ({
  accountId: ID,
  email: 'sara@example.com',
  displayName: 'Sara Ahmadi',
  status: 'active',
  emailVerified: true,
  signedUpAt: '2026-10-01T02:30:00.000Z',
  lastOrderAt: '2026-11-10T02:30:00.000Z',
  orderCount: 3,
  spentMinor: '12550',
  currency: 'AUD',
  refundCount: 1,
  ...over,
});
const counts = {
  all: 120,
  new: 10,
  active: 40,
  inactive: 30,
  'never-ordered': 50,
  disabled: 2,
  'pending-deletion': 1,
};
const page = (items: readonly CustomerRow[], total = items.length): CustomersPage => ({
  items,
  counts,
  paging: { total, page: 1, pageSize: 25, maxRows: 10_000 },
  nextCursor: null,
});
const savedAnswer = { items: [], canShare: false, limits: { perOwner: 50, shared: 20 } };

/** Answers each call by its path; the list answer can be replaced per test. */
function route(list: ApiResult<unknown> = ok(page([row()], 120))) {
  call.mockImplementation((method, path) => {
    if (path.startsWith('customers/admin/saved-filters')) return Promise.resolve(ok(savedAnswer));
    if (path === 'customers/admin/list') return Promise.resolve(list as ApiResult<never>);
    return Promise.resolve(refused(404, 'unknown'));
  });
}

const listProps = {
  accountId: 'admin-1',
  marketId: 'AU',
  marketName: 'Test',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  csrfToken: 'csrf',
};
const VIEW = 'customers.customers.view';
const EXPORT = 'customers.customers.export';
const DISABLE = 'identity.customer-account.disable';

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

const listBodies = () =>
  call.mock.calls.filter((args) => args[1] === 'customers/admin/list').map((args) => args[2]);

describe('the list query', () => {
  it('sends the tab, search and filters as the API takes them, and leaves out a short search', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'active' as const,
      q: ' s ',
      filters: {
        verified: 'no' as const,
        ordersMin: '2',
        spentMax: '5000',
        joinedFrom: '2026-01-01',
      },
    };
    expect(selectorOf(query)).toEqual({
      view: 'active',
      filters: { verified: false, ordersMin: 2, spentMax: '5000', joinedFrom: '2026-01-01' },
    });
    expect(selectorOf({ ...query, q: 'sa', filters: {} })).toEqual({ view: 'active', q: 'sa' });
  });

  it('saves and reopens a filter through the API document (booleans and numbers back to the page)', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'inactive' as const,
      q: 'sara',
      filters: { status: 'disabled' as const, verified: 'yes' as const, ordersMax: '9' },
      sort: 'spent' as const,
      direction: 'desc' as const,
    };
    const payload = payloadOf(query);
    expect(payload.filters).toEqual({ status: 'disabled', verified: true, ordersMax: 9 });
    expect(queryOfPayload(payload, 25)).toEqual({ ...query, page: 1, pageSize: 25 });
  });

  it('drops unknown values of a stored document instead of sending them', () => {
    const query = queryOfPayload(
      { v: 1, view: 'all', filters: { status: 'gone', ordersMin: '-1', joinedTo: 'soon' } },
      25,
    );
    expect(query.filters).toEqual({});
  });
});

describe('CustomersList', () => {
  it('loads the first page with the tab counts, and a row links to the customer page', async () => {
    route();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('120 customers in the Test market')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Never ordered (50)' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Sara Ahmadi' });
    expect(link.getAttribute('href')).toBe(`/customers/${ID}`);
    expect(listBodies()[0]).toEqual({
      view: 'all',
      sort: 'joined',
      direction: 'desc',
      page: 1,
      pageSize: 25,
    });
    expect(screen.getByText('$125.50')).toBeTruthy();
  });

  it('shows the email as the title and "—" as spent for a customer with no name and no order', async () => {
    route(
      ok(page([row({ displayName: null, orderCount: 0, spentMinor: '0', lastOrderAt: null })])),
    );
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByRole('link', { name: 'sara@example.com' })).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('Never')).toBeTruthy();
  });

  it('asks for two characters and does not search on one', async () => {
    route();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    await screen.findByText('Sara Ahmadi');
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 's' } });
    expect(await screen.findByText('Enter at least 2 characters')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Search customers'), { key: 'Enter' });
    await waitFor(() => expect(listBodies().length).toBeGreaterThan(1));
    expect(listBodies().every((body) => !('q' in (body as object)))).toBe(true);
    // A search that is not applied is not a filter: nothing to save, no clear-all.
    expect(screen.queryByRole('button', { name: 'Save filter…' })).toBeNull();
    expect(screen.getByLabelText('Search customers').getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Start of the email, or part of the name')).toBeTruthy();
  });

  it('has no Bulk action menu without the export key, and one with it', async () => {
    route();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    await screen.findByText('Sara Ahmadi');
    expect(screen.queryByRole('button', { name: /Bulk action/ })).toBeNull();
    cleanup();
    route();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW, EXPORT]} />));
    await screen.findByText('Sara Ahmadi');
    expect(screen.getByRole('button', { name: /Bulk action/ })).toBeTruthy();
  });

  it('offers Disable in the row menu only with the identity key, and confirms before it', async () => {
    route();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW, DISABLE]} />));
    await screen.findByText('Sara Ahmadi');
    fireEvent.click(screen.getAllByRole('button', { name: 'Actions for Sara Ahmadi' })[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disable account…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disable this account?' });
    call.mockResolvedValueOnce(ok({ code: 'ok' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disable account' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/customers/${ID}/disable`,
        {},
        'csrf',
      ),
    );
  });

  it('has no status item without the identity key', async () => {
    route();
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    await screen.findByText('Sara Ahmadi');
    fireEvent.click(screen.getAllByRole('button', { name: 'Actions for Sara Ahmadi' })[0]!);
    expect(await screen.findByRole('menuitem', { name: 'Copy email' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Disable account…' })).toBeNull();
  });

  it('says why the list failed and tries again on Retry', async () => {
    route(refused(503, 'access.unavailable'));
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('Customers could not be loaded. Try again.')).toBeTruthy();
    route();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sara Ahmadi')).toBeTruthy();
  });

  it('asks for the two-step code the API names before an export, with the columns shown', async () => {
    route();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'second-factor.required',
            details: { actionKey: 'customers.customers.export' },
          }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(new Response('\uFEFFemail\r\nsara@example.com\r\n', { status: 200 }));
    // The step-up dialog's verify call.
    render(wrap(<CustomersList {...listProps} permissionKeys={[VIEW, EXPORT]} />));
    await screen.findByText('Sara Ahmadi');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Sara Ahmadi' }));
    fireEvent.click(screen.getByRole('button', { name: /Bulk action/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Export…/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Export 1 customer' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    // The code dialog opens for the export's action.
    expect(await screen.findByRole('dialog', { name: /two-step|code|Confirm/i })).toBeTruthy();
    const first = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as object;
    expect(first).toEqual({
      format: 'csv',
      columns: ['name', 'status', 'joined', 'orders', 'spent', 'currency', 'last-order'],
      ids: [ID],
    });
    vi.unstubAllGlobals();
  });
});

const overview = (over: Partial<CustomerOverview> = {}): CustomerOverview => ({
  ...row(),
  firstOrderAt: '2026-10-05T02:30:00.000Z',
  refundedMinor: '1000',
  ...over,
});

const pageProps = {
  accountId: ID,
  adminAccountId: 'admin-1',
  marketId: 'AU',
  initialTab: 'overview' as const,
  csrfToken: 'csrf',
  zone: 'Australia/Brisbane',
  paging: 'pages' as const,
  waitingPeriodDays: 30,
};

function routePage(answer: ApiResult<unknown> = ok(overview())) {
  call.mockImplementation((method, path) => {
    if (path === `customers/admin/customers/${ID}`)
      return Promise.resolve(answer as ApiResult<never>);
    if (path === `customers/admin/customers/${ID}/tab-opened`)
      return Promise.resolve(ok({ ok: true }) as ApiResult<never>);
    if (path === `wallet/admin/customers/${ID}`)
      return Promise.resolve(ok({ available: '2500', currency: 'AUD' }) as ApiResult<never>);
    if (path.startsWith('ordering/admin/orders'))
      return Promise.resolve(
        ok({
          orders: [],
          nextCursor: null,
          counts: { pendingPayment: 0, confirmed: 0, cancelled: 0 },
          total: null,
          paging: 'prev-next',
          hasNext: false,
          page: 1,
          pageSize: 25,
          searchCapped: false,
          searchScope: null,
        }) as ApiResult<never>,
      );
    if (path === `ordering/admin/customers/${ID}/refunds`)
      return Promise.resolve(
        ok({
          items: [],
          page: 1,
          pageSize: 25,
          paging: 'pages',
          total: 0,
          hasNext: false,
        }) as ApiResult<never>,
      );
    return Promise.resolve(refused(404, 'unknown'));
  });
}

describe('the customer page', () => {
  it('shows the tabs an admin may open', () => {
    expect(tabsFor(new Set([VIEW]))).toEqual(['overview', 'money', 'security']);
    expect(tabsFor(new Set([VIEW, 'ordering.order.view']))).toEqual([
      'overview',
      'orders',
      'money',
      'security',
    ]);
    expect(tabsFor(new Set())).toEqual(['overview', 'money']);
    expect(averageMinor('12550', 3)).toBe('4183');
    expect(averageMinor('0', 0)).toBeNull();
  });

  it('shows the header, the figures and the profile from the audited Overview read', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, 'wallet.credit.view']} />));
    expect(await screen.findByRole('heading', { name: 'Sara Ahmadi', level: 1 })).toBeTruthy();
    expect(screen.getByText('Email verified', { selector: 'span' })).toBeTruthy();
    expect(await screen.findByText('$25.00')).toBeTruthy();
    expect(screen.getByText('1 refund')).toBeTruthy();
    expect(screen.getByText('$41.83')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', `customers/admin/customers/${ID}`);
  });

  it('says when an erased customer was deleted, and shows nothing else about them', async () => {
    routePage(ok({ accountId: ID, status: 'deleted', deletedAt: '2026-11-10T23:30:00Z' }));
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('Account deleted')).toBeTruthy();
    expect(screen.getByText(/was deleted on 11 Nov 2026/)).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('is "not found" for a customer of another Market, and a page-level error with Retry otherwise', async () => {
    routePage(refused(404, 'customers.customer-not-found'));
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('Customer not found')).toBeTruthy();
    cleanup();
    routePage(refused(503, 'access.unavailable'));
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText("Customer couldn't be loaded")).toBeTruthy();
    routePage();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Sara Ahmadi' })).toBeTruthy();
  });

  it('records the opening of Orders once per visit, then lists only this customer’s orders', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, 'ordering.order.view']} />));
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    await waitFor(() =>
      expect(
        call.mock.calls.some((args) => String(args[1]).startsWith('ordering/admin/orders')),
      ).toBe(true),
    );
    const orders = call.mock.calls.find((args) =>
      String(args[1]).startsWith('ordering/admin/orders'),
    );
    expect(String(orders?.[1])).toContain(`accountId=${ID}`);
    // No saved filters on a customer's orders.
    expect(
      call.mock.calls.some((args) => String(args[1]).startsWith('ordering/admin/saved-filters')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }));
    await act(async () => Promise.resolve());
    const opened = call.mock.calls.filter((args) => String(args[1]).endsWith('/tab-opened'));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.[2]).toEqual({ tab: 'orders' });
    expect(window.location.search).toBe('?tab=orders');
  });

  it('shows only the Money sections whose keys the admin holds', async () => {
    routePage();
    render(
      wrap(
        <CustomerPage
          {...pageProps}
          initialTab="money"
          permissionKeys={[VIEW, 'ordering.order.view']}
        />,
      ),
    );
    expect(await screen.findByText('Refunds and credit notes')).toBeTruthy();
    expect(await screen.findByText('No refunds')).toBeTruthy();
    expect(screen.queryByText('Wallet history')).toBeNull();
    expect(screen.queryByText('Promotion credits')).toBeNull();
    expect(screen.queryByText('Wallet balance')).toBeNull();
  });

  it('opens the delete dialog from More actions, and offers no delete without its key', async () => {
    routePage();
    render(
      wrap(
        <CustomerPage
          {...pageProps}
          permissionKeys={[VIEW, DISABLE, 'customers.buyer-account.delete']}
        />,
      ),
    );
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    expect(screen.queryByRole('button', { name: "Delete this buyer's account" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete account…' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    cleanup();
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, DISABLE]} />));
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Disable account…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete account…' })).toBeNull();
  });
});

const VERIFY = 'identity/admin/step-up/verify';
const csv = (lines: readonly string[]) => new Response(`\uFEFF${lines.join('\r\n')}\r\n`);
const required = () =>
  new Response(
    JSON.stringify({
      code: 'second-factor.required',
      details: { actionKey: 'customers.customers.export' },
    }),
    { status: 403 },
  );
const bulkProps = {
  query: DEFAULT_QUERY,
  columns: ['status'] as const,
  permissionKeys: [EXPORT],
  csrfToken: 'csrf',
  onSelectAll: () => undefined,
  onClear: () => undefined,
};
async function exportAs(format: 'CSV' | 'XLSX' = 'CSV') {
  fireEvent.click(screen.getByRole('button', { name: /Bulk action/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Export…/ }));
  const dialog = await screen.findByRole('dialog', { name: /^Export / });
  if (format === 'XLSX') fireEvent.click(within(dialog).getByRole('radio', { name: /XLSX/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
}
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, index = 0) =>
  JSON.parse((fetchMock.mock.calls[index]![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;

describe('the customer export', () => {
  const createObjectURL = vi.fn(() => 'blob:x');
  beforeEach(() => {
    createObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('verifies the code, sends the export again, downloads it and counts the rows', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(required())
      .mockResolvedValueOnce(csv(['email', 'sara@example.com', 'omar@example.com']));
    call.mockResolvedValueOnce(ok({ code: 'step-up-verified' }));
    render(
      wrap(
        <CustomersBulk
          {...bulkProps}
          selection={{ ids: [ID, ID], allMatching: false, total: 2 }}
        />,
      ),
    );
    await exportAs();
    await screen.findByRole('dialog', { name: 'Confirm it is you' });
    fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit \d of 6/ })[0]!, {
      clipboardData: { getData: () => '123456' },
    });
    expect(await screen.findByText('2 customers exported.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      VERIFY,
      { actionKey: 'customers.customers.export', code: '123456' },
      'csrf',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1)).toEqual(sentBody(fetchMock, 0));
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('says the export was cancelled when the code is not given, and downloads nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(required());
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <CustomersBulk {...bulkProps} selection={{ ids: [ID], allMatching: false, total: 1 }} />,
      ),
    );
    await exportAs();
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Export cancelled.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('asks an admin without two-step codes to set them up, and says so when they close it', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'second-factor.enrolment-required',
          details: { actionKey: 'customers.customers.export' },
        }),
        { status: 403 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <CustomersBulk {...bulkProps} selection={{ ids: [ID], allMatching: false, total: 1 }} />,
      ),
    );
    await exportAs();
    const dialog = await screen.findByRole('dialog', {
      name: 'Set up two-step verification first',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByText('Set up two-step verification on your profile to export customers.'),
    ).toBeTruthy();
  });

  it('says how many can be exported when the list is too large', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12000 } }),
          { status: 422 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(
      wrap(
        <CustomersBulk {...bulkProps} selection={{ ids: [], allMatching: true, total: 9000 }} />,
      ),
    );
    await exportAs();
    expect(
      await screen.findByText(
        'Up to 10,000 customers can be exported at once; this list has 12,000. Narrow it first.',
      ),
    ).toBeTruthy();
    // "Select all" sends the list's filter, never ids.
    const body = sentBody(fetchMock);
    expect(body['ids']).toBeUndefined();
    expect(body['view']).toBe('all');
  });

  it('refuses more than 1000 ticked rows instead of exporting the whole filter', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ids = Array.from({ length: 1001 }, (_, index) => `id-${index}`);
    render(
      wrap(<CustomersBulk {...bulkProps} selection={{ ids, allMatching: false, total: 8000 }} />),
    );
    await exportAs();
    expect(
      await screen.findByText(
        'You can export up to 1,000 ticked customers. Use Select all, or narrow the list.',
      ),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers Select all up to 10,000 customers, and not above', async () => {
    render(
      wrap(
        <CustomersBulk {...bulkProps} selection={{ ids: [ID], allMatching: false, total: 9000 }} />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk action/ }));
    expect(await screen.findByText('Select all 9,000 customers in this filter')).toBeTruthy();
    cleanup();
    render(
      wrap(
        <CustomersBulk
          {...bulkProps}
          selection={{ ids: [ID], allMatching: false, total: 10_001 }}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk action/ }));
    await screen.findByRole('menuitem', { name: /Export…/ });
    // (An earlier test's error toast may still mention Select all.)
    expect(screen.queryByText(/^Select all \d/)).toBeNull();
  });
});

describe('Select all with the order number filter on', () => {
  it('disables Select all with a hint, and keeps ticked-row export open', async () => {
    render(
      wrap(
        <CustomersBulk
          {...bulkProps}
          orderNumberActive
          selection={{ ids: [ID], allMatching: false, total: 9000 }}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Bulk action/ }));
    const blocked = await screen.findByRole('menuitem', {
      name: /Select all 9,000 customers in this filter/,
    });
    expect(blocked.getAttribute('aria-disabled') ?? blocked.hasAttribute('disabled')).toBeTruthy();
    expect(screen.getByText('Clear the order number filter to select all or export.')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Export…/ })).toBeTruthy();
  });
});

describe.each([
  { market: 'AU', currency: 'AUD', typed: '12.50', minor: '1250', shown: '$12.50' },
  { market: 'JP', currency: 'JPY', typed: '1250', minor: '1250', shown: 'JPY 1,250' },
  { market: 'KW', currency: 'KWD', typed: '1.250', minor: '1250', shown: 'KWD 1.250' },
])('the spent filter in a $currency market', ({ currency, typed, minor }) => {
  it('turns the typed amount into minor units and back', () => {
    expect(majorOf(minor, currency)).toBe(typed);
    const onApply = vi.fn();
    render(
      wrap(
        <CustomersFilterPanel
          filters={{}}
          currency={currency}
          onApply={onApply}
          close={() => undefined}
        />,
      ),
    );
    const spent = screen.getByRole('group', { name: 'Spent' });
    fireEvent.change(within(spent).getByLabelText('From'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ spentMin: minor });
  });
});

describe('the filter panel', () => {
  const show = (props: Partial<Parameters<typeof CustomersFilterPanel>[0]> = {}) => {
    const onApply = vi.fn();
    render(
      wrap(
        <CustomersFilterPanel
          filters={{}}
          currency="AUD"
          onApply={onApply}
          close={() => undefined}
          {...props}
        />,
      ),
    );
    return onApply;
  };

  it('refuses a range that ends before it starts, and an amount over the API limit', () => {
    const onApply = show();
    const orders = screen.getByRole('group', { name: 'Orders' });
    fireEvent.change(within(orders).getByLabelText('From'), { target: { value: '5' } });
    fireEvent.change(within(orders).getByLabelText('To'), { target: { value: '2' } });
    const spent = screen.getByRole('group', { name: 'Spent' });
    fireEvent.change(within(spent).getByLabelText('From'), {
      target: { value: '999999999999999.99' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('The end comes before the start.')).toBeTruthy();
    expect(screen.getByText('Enter a smaller amount.')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('keeps a spent bound it cannot show when no currency is known', () => {
    const onApply = show({ filters: { spentMin: '5000', ordersMin: '1' }, currency: null });
    expect(screen.queryByRole('group', { name: 'Spent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ ordersMin: '1', spentMin: '5000' });
  });
});

describe('a second Market (NZD, Pacific/Auckland)', () => {
  it('shows spent in the rows’ currency and days in the given zone', async () => {
    route(ok(page([row({ currency: 'NZD', spentMinor: '9900' })])));
    render(
      wrap(
        <CustomersList
          {...listProps}
          marketId="NZ"
          marketName="New Zealand"
          zone="Pacific/Auckland"
          permissionKeys={[VIEW]}
        />,
      ),
    );
    expect(await screen.findByText('120 customers in the New Zealand market')).toBeTruthy();
    await screen.findByText('Sara Ahmadi');
    expect(screen.getByText('NZD 99.00')).toBeTruthy();
  });

  it('reads a day in the owning zone at the day boundary', () => {
    const instant = '2026-11-02T21:00:00.000Z';
    expect(dayOf(instant, 'en-AU', 'Australia/Brisbane')).toBe('3 Nov 2026');
    expect(dayOf(instant, 'en-AU', 'Europe/London')).toBe('2 Nov 2026');
    // 12:30Z is 10:30 pm in Brisbane and already the next day (1:30 am) in Auckland.
    const late = '2026-11-02T12:30:00.000Z';
    expect(dayOf(late, 'en-AU', 'Australia/Brisbane')).toBe('2 Nov 2026');
    expect(dayOf(late, 'en-AU', 'Pacific/Auckland')).toBe('3 Nov 2026');
  });
});

describe('an order opened from a customer page', () => {
  it('carries the customer and tab, and Back returns there', () => {
    const href = orderHref('o-1', { accountId: ID, tab: 'orders' });
    expect(href).toBe(`/orders/o-1?customer=${ID}&from=orders`);
    expect(backHrefOf(customerOriginOf(ID, 'money'))).toBe(`/customers/${ID}?tab=money`);
    expect(customerOriginOf('nope', 'orders')).toBeUndefined();
    expect(customerOriginOf(ID, 'secret')).toBeUndefined();
    expect(backHrefOf(undefined)).toBe('/orders');
  });
});

describe('a customer with an open deletion request', () => {
  const pending = {
    requestId: '0190a000-0000-7000-8000-0000000000d1',
    status: 'pending' as const,
    requestedAt: '2026-11-10T00:00:00.000Z',
    scheduledFor: '2026-11-24T00:00:00.000Z',
  };
  const keys = [VIEW, 'customers.buyer-account.delete'];

  it('shows the badge and the date with Cancel, and offers no second request', async () => {
    routePage(ok(overview({ deletionRequest: pending })));
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[...keys, DISABLE]} />));
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    expect(screen.getByText(/The account will be deleted on 24 Nov 2026, 10:00\s?am/)).toBeTruthy();
    expect(screen.getAllByText('Deletion pending').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Cancel deletion request…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await screen.findByRole('menuitem', { name: 'Disable account…' });
    expect(screen.queryByRole('menuitem', { name: 'Delete account…' })).toBeNull();
  });

  it('offers no Cancel while the request is being carried out', async () => {
    routePage(ok(overview({ deletionRequest: { ...pending, status: 'executing' } })));
    render(wrap(<CustomerPage {...pageProps} permissionKeys={keys} />));
    expect(
      await screen.findByText("The account is being deleted now. The request can't be cancelled."),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel deletion request…' })).toBeNull();
  });

  it('shows the badge to an admin who may not delete', async () => {
    routePage(ok(overview({ deletionRequest: pending })));
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW]} />));
    expect(await screen.findByText('Deletion pending')).toBeTruthy();
  });
});

describe('the wallet tile', () => {
  it('is left out when the Market wallet is switched off', async () => {
    routePage();
    const base = call.getMockImplementation()!;
    call.mockImplementation((method, path, ...rest) =>
      path === `wallet/admin/customers/${ID}`
        ? Promise.resolve(refused(404, 'wallet.disabled'))
        : base(method, path, ...rest),
    );
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, 'wallet.credit.view']} />));
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    await act(async () => Promise.resolve());
    expect(screen.queryByText('Wallet balance')).toBeNull();
    expect(screen.queryByText('Could not be read')).toBeNull();
  });
});

describe('the customer page tabs', () => {
  it('are ARIA tabs that move with the arrow keys and name the panel', async () => {
    routePage();
    render(wrap(<CustomerPage {...pageProps} permissionKeys={[VIEW, 'ordering.order.view']} />));
    await screen.findByRole('heading', { name: 'Sara Ahmadi' });
    const overviewTab = screen.getByRole('tab', { name: 'Overview' });
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Overview' })).toBeTruthy();
    fireEvent.keyDown(overviewTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Orders' }), { key: 'End' });
    expect(
      screen.getByRole('tab', { name: 'Account & security' }).getAttribute('aria-selected'),
    ).toBe('true');
  });
});
