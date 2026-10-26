// @vitest-environment jsdom
import { visibleNavItems } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { Earnings } from './earnings.tsx';
import type { Ledger, LedgerEntry } from './types.ts';

const call = vi.mocked(callApi);
const entry = (n: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  entryId: `0190a000-0000-7000-8000-00000000e${n.toString().padStart(3, '0')}`,
  orderId: `0190a000-0000-7000-8000-00000000b${n.toString().padStart(3, '0')}`,
  kind: 'sale',
  direction: 'credit',
  amount: '3000',
  occurredAt: '2026-10-14T10:00:00.000Z',
  ...over,
});
const ledger = (
  entries: LedgerEntry[],
  nextCursor: string | null = null,
  currency = 'AUD',
): Ledger => ({
  sellerId: 's',
  currency,
  totals: {
    sales: '3000',
    shipping: '500',
    commission: '450',
    refundedSales: '0',
    refundedShipping: '0',
    refundedCommission: '0',
    disputeDebits: '0',
    disputeReinstated: '0',
    balance: '3050',
  },
  entries,
  nextCursor,
});
const mount = (initial: Ledger) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <Earnings initial={initial} />
    </NextIntlClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Earnings', () => {
  it('shows the four totals formatted from minor units', () => {
    mount(ledger([entry(1)]));
    for (const [label, value] of [
      ['Sales', '$30.00'],
      ['Shipping', '$5.00'],
      ['Commission', '$4.50'],
      ['Balance', '$30.50'],
    ] as const) {
      const term = screen.getAllByText(label).find((node) => node.tagName === 'DT');
      expect(term?.nextElementSibling?.textContent).toBe(value);
    }
  });

  it('shows refunds, the commission returned and a balance below zero', () => {
    const initial = ledger([
      entry(1, { kind: 'refund-sale', direction: 'debit', amount: '1100' }),
      entry(2, { kind: 'refund-commission', direction: 'credit', amount: '150' }),
      entry(3, { kind: 'refund-shipping', direction: 'debit', amount: '250' }),
    ]);
    mount({
      ...initial,
      totals: {
        ...initial.totals,
        refundedSales: '1100',
        refundedShipping: '250',
        refundedCommission: '150',
        balance: '-1200',
      },
    });
    for (const [label, value] of [
      ['Refunds', '$13.50'],
      ['Commission returned', '$1.50'],
      ['Balance', '-$12.00'],
    ] as const) {
      const term = screen.getAllByText(label).find((node) => node.tagName === 'DT');
      expect(term?.nextElementSibling?.textContent).toBe(value);
    }
    // No dispute yet: no Disputes tile.
    expect(screen.queryByText('Disputes')).toBeNull();
    const rows = within(screen.getByRole('table', { name: 'Ledger' })).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Refund of sale')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('−$11.00')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Commission returned')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('$1.50')).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText('Refund of shipping')).toBeTruthy();
  });

  it('shows the dispute tile and kinds once disputes exist', () => {
    const initial = ledger([
      entry(1, { kind: 'dispute-debit', direction: 'debit', amount: '900' }),
      entry(2, { kind: 'dispute-reinstate', direction: 'credit', amount: '400' }),
    ]);
    mount({
      ...initial,
      totals: { ...initial.totals, disputeDebits: '900', disputeReinstated: '400' },
    });
    const term = screen.getAllByText('Disputes').find((node) => node.tagName === 'DT');
    expect(term?.nextElementSibling?.textContent).toBe('$5.00');
    expect(screen.getByText('Dispute debit')).toBeTruthy();
    expect(screen.getByText('Dispute reinstated')).toBeTruthy();
  });

  it('formats in the ledger currency, never assuming AUD', () => {
    mount(ledger([entry(1, { amount: '500' })], null, 'JPY'));
    expect(screen.getAllByText(/JPY\s500/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/A\$/)).toBeNull();
  });

  it('lists rows with kind, signed amount and an end-aligned amount column', () => {
    mount(ledger([entry(1), entry(2, { kind: 'commission', direction: 'debit', amount: '450' })]));
    const table = screen.getByRole('table', { name: 'Ledger' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[2] as HTMLElement).getByText('Commission')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('−$4.50')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('$30.00').className).toContain('text-end');
    expect(screen.getByRole('columnheader', { name: 'Amount' }).className).toContain('text-end');
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('hides the Order column on phones and repeats the reference under the date', () => {
    mount(ledger([entry(1)]));
    const header = screen.getByRole('columnheader', { name: 'Order' });
    expect(header.className).toContain('hidden');
    expect(header.className).toContain('sm:table-cell');
    const cell = screen.getAllByText('0000B001').find((node) => node.tagName === 'TD');
    expect(cell?.className).toContain('hidden');
    expect(cell?.className).toContain('sm:table-cell');
    const small = screen.getAllByText('0000B001').find((node) => node.tagName === 'SPAN');
    expect(small?.className).toContain('sm:hidden');
  });

  it('shows an empty state and no table without rows', () => {
    mount(ledger([]));
    expect(screen.getByRole('heading', { name: 'No earnings yet' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('loads the next page with the cursor and hides the button at the end', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: ledger([entry(1), entry(2)], null),
    });
    mount(ledger([entry(1)], 'c 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(call).toHaveBeenCalledWith(
      'GET',
      'commission-payouts/seller/ledger?limit=20&cursor=c%201',
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says so when more rows cannot be loaded and keeps the button', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'x' } });
    mount(ledger([entry(1)], 'c1'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/More rows could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });
});

describe('the nav', () => {
  it('shows Earnings only with the earnings view permission', () => {
    const ids = (keys: string[]) => visibleNavItems(sellerNav, new Set(keys)).map((i) => i.id);
    expect(ids(['commission-payouts.earnings.view'])).toContain('s_earnings');
    expect(ids([])).not.toContain('s_earnings');
  });
});
