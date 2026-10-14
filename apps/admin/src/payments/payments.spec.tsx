// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AccountDetail } from './account-detail.tsx';
import { AccountsList } from './accounts-list.tsx';
import type { ConnectedAccountDetail, ConnectedAccountPage, ConnectedAccountRow } from './types.ts';

const call = vi.mocked(callApi);
const row = (over: Partial<ConnectedAccountRow> = {}): ConnectedAccountRow => ({
  sellerId: '0190a000-0000-7000-8000-000000000001',
  sellerName: 'Cedar Lane Halal Meats',
  status: 'enabled',
  ready: true,
  requirementsDue: 0,
  requirementsPastDue: false,
  coolingOffUntil: null,
  payoutsPaused: false,
  lastReadAt: '2026-10-13T01:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const page = (items: ConnectedAccountRow[], nextCursor: string | null = null) => ({
  ok: true as const,
  status: 200,
  body: { items, nextCursor } satisfies ConnectedAccountPage,
});
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('connected accounts list', () => {
  it('lists the accounts with status, readiness and requirements', async () => {
    call.mockResolvedValueOnce(
      page([
        row(),
        row({
          sellerId: '0190a000-0000-7000-8000-000000000002',
          sellerName: null,
          status: 'restricted',
          ready: false,
          requirementsDue: 2,
          requirementsPastDue: true,
          coolingOffUntil: '2026-10-16T03:30:00.000Z',
          payoutsPaused: true,
        }),
      ]),
    );
    render(wrap(<AccountsList />));
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'Cedar Lane Halal Meats' })).toBeTruthy();
    expect(within(table).getByText('Unnamed seller')).toBeTruthy();
    expect(within(table).getByText('Restricted')).toBeTruthy();
    expect(within(table).getByText('Past due')).toBeTruthy();
    expect(within(table).getByText(/16 Oct 2026/)).toBeTruthy();
    expect(call).toHaveBeenCalledWith('GET', 'payments/admin/connected-accounts');
  });

  it('links each row to its detail page', async () => {
    call.mockResolvedValueOnce(page([row()]));
    render(wrap(<AccountsList />));
    const link = await screen.findByRole('link', { name: 'Cedar Lane Halal Meats' });
    expect(link.getAttribute('href')).toBe('/payout-accounts/0190a000-0000-7000-8000-000000000001');
  });

  it('filters by status and asks again', async () => {
    call.mockResolvedValue(page([row()]));
    render(wrap(<AccountsList />));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        'payments/admin/connected-accounts?status=pending',
      ),
    );
  });

  it('clears the old rows while another tab loads', async () => {
    call.mockResolvedValueOnce(page([row()]));
    render(wrap(<AccountsList />));
    await screen.findByRole('table');
    call.mockReturnValueOnce(new Promise(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
  });

  it('pages by cursor with Show more', async () => {
    call.mockResolvedValueOnce(page([row()], 'next-1'));
    render(wrap(<AccountsList />));
    await screen.findByRole('table');
    call.mockResolvedValueOnce(
      page([row({ sellerId: '0190a000-0000-7000-8000-000000000003', sellerName: 'Olive Grove' })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Olive Grove')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', 'payments/admin/connected-accounts?cursor=next-1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows an empty state', async () => {
    call.mockResolvedValueOnce(page([]));
    render(wrap(<AccountsList />));
    expect(await screen.findByText(/No connected accounts yet/)).toBeTruthy();
  });

  it('shows the error with a retry that loads again', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 503, code: 'payments.unavailable' },
    });
    render(wrap(<AccountsList />));
    expect(await screen.findByText(/couldn't load the connected accounts/)).toBeTruthy();
    call.mockResolvedValueOnce(page([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});

describe('connected account detail', () => {
  const detail = (over: Partial<ConnectedAccountDetail> = {}): ConnectedAccountDetail => ({
    ...row({ requirementsDue: 1, requirementsPastDue: true }),
    changes: [
      { detectedAt: '2026-10-13T01:00:00.000Z', kind: 'updated' },
      { detectedAt: '2026-10-01T01:00:00.000Z', kind: 'initial' },
    ],
    ...over,
  });

  it('shows the fields and the change history', () => {
    render(wrap(<AccountDetail account={detail()} />));
    expect(screen.getByRole('heading', { name: 'Cedar Lane Halal Meats' })).toBeTruthy();
    expect(screen.getByText('Requirements past due')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Bank account updated');
    expect(items[1]).toContain('First bank account added');
  });

  it('says so when nothing changed', () => {
    render(wrap(<AccountDetail account={detail({ changes: [], sellerName: null })} />));
    expect(screen.getByText('No changes recorded.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Unnamed seller' })).toBeTruthy();
  });
});

describe('connected accounts nav', () => {
  it('shows the entry only with the view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('payout-accounts');
    expect(ids(['payments.connected-account.view'])).toContain('payout-accounts');
  });
});
