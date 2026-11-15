// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { Toaster } from '@mondapac/ui';
import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { CustomerPage } from './customer-page.tsx';
import { CustomersList } from './customers-list.tsx';
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
    expect(await screen.findByText('Enter at least 2 characters to search.')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Search customers'), { key: 'Enter' });
    await waitFor(() => expect(listBodies().length).toBeGreaterThan(1));
    expect(listBodies().every((body) => !('q' in (body as object)))).toBe(true);
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
      .mockResolvedValueOnce(new Response('﻿email\r\nsara@example.com\r\n', { status: 200 }));
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
      return Promise.resolve(ok({ orders: [], nextCursor: null, total: 0 }) as ApiResult<never>);
    if (path === `ordering/admin/customers/${ID}/refunds`)
      return Promise.resolve(ok({ refunds: [] }) as ApiResult<never>);
    return Promise.resolve(refused(404, 'unknown'));
  });
}

describe('the customer page', () => {
  it('shows the tabs an admin may open', () => {
    expect(tabsFor(new Set([VIEW]))).toEqual(['overview', 'money']);
    expect(tabsFor(new Set([VIEW, 'ordering.order.view']))).toEqual([
      'overview',
      'orders',
      'money',
    ]);
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
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
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
