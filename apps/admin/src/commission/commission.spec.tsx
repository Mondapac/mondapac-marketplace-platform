// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { commissionProblemOf } from './errors.ts';
import { LedgerCard } from './ledger-card.tsx';
import { CommissionRateCard } from './rate-card.tsx';
import { bpsOf, percentOf, type CommissionRate, type Ledger, type LedgerEntry } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const RATE = `commission-payouts/admin/sellers/${SELLER}/commission-rate`;
const rate = (rateBps: number, source: 'seller' | 'market' = 'seller'): CommissionRate => ({
  sellerId: SELLER,
  rateBps,
  source,
  marketRateBps: 1500,
});

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const mountRate = (initial: CommissionRate, canEdit = true) =>
  render(wrap(<CommissionRateCard initial={initial} canEdit={canEdit} csrfToken="csrf" />));

describe('CommissionRateCard', () => {
  it('shows the Market rate as a percent with its source', () => {
    mountRate(rate(1500, 'market'));
    expect(screen.getByText('15%')).toBeTruthy();
    expect(screen.getByText('Market default')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset to Market rate' })).toBeNull();
  });

  it('shows the seller own rate, with the Market rate beside it, and a reset button', () => {
    mountRate(rate(1250));
    expect(screen.getByText('12.5%')).toBeTruthy();
    expect(screen.getByText("This seller's own rate")).toBeTruthy();
    expect(screen.getByText('The Market rate is 15%.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to Market rate' })).toBeTruthy();
  });

  it('hides every control without the edit permission', () => {
    mountRate(rate(1250), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('saves the percent as basis points and shows the answer', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: rate(1275) });
    mountRate(rate(1500, 'market'));
    fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: '12.75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith('PUT', RATE, { rateBps: 1275 }, 'csrf');
    expect(await screen.findByText(/Rate saved/)).toBeTruthy();
    expect(screen.getByText('12.75%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to Market rate' })).toBeTruthy();
  });

  it('refuses a bad percent before calling the API', () => {
    mountRate(rate(1500));
    for (const bad of ['', 'abc', '-1', '12.345', '30.01', '31']) {
      fireEvent.change(screen.getByLabelText(/Commission rate/), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
      expect(screen.getByText(/Enter a percentage between 0 and 30/)).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('asks before resetting, and sends DELETE only after the confirm', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: rate(1500, 'market') });
    mountRate(rate(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset to the Market rate?' });
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, reset' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('DELETE', RATE, undefined, 'csrf'));
    expect(await screen.findByText(/back on the Market rate/)).toBeTruthy();
    expect(screen.getByText('Market default')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reset to Market rate' })).toBeNull();
  });

  it('cancelling the confirm sends nothing', () => {
    mountRate(rate(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
  });

  it('treats rate-not-set as already on the Market rate', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 404, code: 'commission-payouts.rate-not-set' },
    });
    mountRate(rate(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Market rate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset' }));
    expect(await screen.findByText(/already on the Market rate/)).toBeTruthy();
    expect(screen.getByText('Market default')).toBeTruthy();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mountRate(rate(1500));
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }));
    expect(await screen.findByText('Your role cannot change commission rates.')).toBeTruthy();
  });
});

const entry = (n: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  entryId: `0190a000-0000-7000-8000-00000000e${n.toString().padStart(3, '0')}`,
  orderId: `0190a000-0000-7000-8000-00000000b${n.toString().padStart(3, '0')}`,
  kind: 'sale',
  direction: 'credit',
  amount: '3000',
  occurredAt: '2026-10-14T10:00:00.000Z',
  ...over,
});
const ledger = (entries: LedgerEntry[], nextCursor: string | null = null): Ledger => ({
  sellerId: SELLER,
  currency: 'AUD',
  totals: { sales: '3000', shipping: '500', commission: '450', balance: '3050' },
  entries,
  nextCursor,
});
const mountLedger = (initial: Ledger) => render(wrap(<LedgerCard initial={initial} />));

describe('LedgerCard', () => {
  it('shows totals and rows, the commission as a debit', () => {
    mountLedger(
      ledger([entry(1), entry(2, { kind: 'commission', direction: 'debit', amount: '450' })]),
    );
    const balance = screen.getAllByText('Balance').find((n) => n.tagName === 'DT');
    expect(balance?.nextElementSibling?.textContent).toBe('$30.50');
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('−$4.50')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Amount' }).className).toContain('text-end');
  });

  it('shows an empty state without rows', () => {
    mountLedger(ledger([]));
    expect(screen.getByText(/No ledger rows yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('loads more with the cursor, skipping rows already shown', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: ledger([entry(1), entry(2)], null) });
    mountLedger(ledger([entry(1)], 'c1'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    expect(call).toHaveBeenCalledWith(
      'GET',
      `commission-payouts/admin/sellers/${SELLER}/ledger?limit=20&cursor=c1`,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('reports a failed page and keeps the button', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'x' } });
    mountLedger(ledger([entry(1)], 'c1'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(/More rows could not be loaded/)).toBeTruthy();
  });
});

describe('helpers', () => {
  it('convert percent and basis points exactly', () => {
    expect(bpsOf('15')).toBe(1500);
    expect(bpsOf('12.5')).toBe(1250);
    expect(bpsOf('0.05')).toBe(5);
    expect(bpsOf('30')).toBe(3000);
    expect(bpsOf('30.00')).toBe(3000);
    expect(bpsOf('30.01')).toBeNull();
    expect(bpsOf('1.234')).toBeNull();
    expect(bpsOf('')).toBeNull();
    expect(percentOf(1500, 'en-AU')).toBe('15');
    expect(percentOf(1275, 'en-AU')).toBe('12.75');
  });

  it('name a failed call', () => {
    expect(commissionProblemOf({ status: 404, code: 'commission-payouts.rate-not-set' })).toBe(
      'not-set',
    );
    expect(commissionProblemOf({ status: 503, code: 'x' })).toBe('unavailable');
    expect(commissionProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
