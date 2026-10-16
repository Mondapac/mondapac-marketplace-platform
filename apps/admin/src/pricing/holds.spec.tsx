// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { formatMoney } from './format.ts';
import { holdProblemOf } from './hold-errors.ts';
import { HoldsQueue } from './holds-queue.tsx';
import type { PriceHoldRow } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000c1';
const row = (over: Partial<PriceHoldRow> = {}): PriceHoldRow => ({
  recordId: ID,
  offerId: '0190a000-0000-7000-8000-0000000000d1',
  variantId: '0190a000-0000-7000-8000-0000000000e1',
  sellerId: '0190a000-0000-7000-8000-0000000000f1',
  productName: 'Halal beef mince 500 g',
  variantLabel: 'Family pack',
  storeName: 'Logan Road Grocer',
  kind: 'regular',
  amount: { amount: '1999', currency: 'AUD' },
  anchorAmount: { amount: '1000', currency: 'AUD' },
  direction: 'up',
  submittedAt: '2026-10-14T01:00:00.000Z',
  ...over,
});

function mount(canDecide = true, rows: PriceHoldRow[] = [row()]) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <HoldsQueue rows={rows} canDecide={canDecide} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const fail = (status: number, code: string) =>
  call.mockResolvedValueOnce({ ok: false, failure: { status, code } });

describe('admin held prices', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('formats minor units in the currency', () => {
    expect(formatMoney({ amount: '1999', currency: 'AUD' }, 'en-AU')).toContain('19.99');
    expect(formatMoney({ amount: 'x', currency: 'AUD' }, 'en-AU')).toBe('-');
  });

  it('shows a record with its price and anchor, and an empty state', () => {
    mount();
    expect(screen.getByText('$19.99')).toBeTruthy();
    expect(screen.getByText('$10.00')).toBeTruthy();
    cleanup();
    mount(true, []);
    expect(screen.getByText('No held prices are waiting for a decision.')).toBeTruthy();
  });

  it('names the product, its variant and the store, with the ids as tooltips', () => {
    mount();
    expect(screen.getByText('Halal beef mince 500 g').getAttribute('title')).toBe(
      '0190a000-0000-7000-8000-0000000000d1',
    );
    expect(screen.getByText('Family pack')).toBeTruthy();
    const store = screen.getByRole('link', { name: 'Logan Road Grocer' });
    expect(store.getAttribute('href')).toBe('/sellers/0190a000-0000-7000-8000-0000000000f1');
  });

  it('keeps the row when a name could not be read and shows a short id instead', () => {
    mount(true, [row({ productName: null, variantLabel: null, storeName: null })]);
    expect(screen.getByText('Name unavailable (000000D1)')).toBeTruthy();
    expect(screen.queryByText('Family pack')).toBeNull();
    const seller = screen.getByRole('link', { name: 'Seller 000000F1' });
    expect(seller.getAttribute('href')).toBe('/sellers/0190a000-0000-7000-8000-0000000000f1');
    expect(screen.getByText('$19.99')).toBeTruthy();
  });

  it('shows seller-entered names as plain text', () => {
    mount(true, [row({ productName: '<b>Bold</b>' })]);
    expect(screen.getByText('<b>Bold</b>')).toBeTruthy();
  });

  it('approves after a confirmation and removes the row', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(screen.getByText('Price approved.')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `pricing/admin/price-holds/${ID}/approve`,
      undefined,
      'csrf-1',
    );
    expect(screen.queryByText('$19.99')).toBeNull();
  });

  it('rejects with a reason code and an optional note', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Reject price' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'policy-breach' } });
    fireEvent.change(screen.getByLabelText('Note for the seller (optional)'), {
      target: { value: ' too high ' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText(/Price rejected/)).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `pricing/admin/price-holds/${ID}/reject`,
      { reasonCode: 'policy-breach', note: 'too high' },
      'csrf-1',
    );
  });

  it('keeps the row and explains when the submitter tries to decide', async () => {
    fail(403, 'pricing.hold.own-submission');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    expect(await screen.findByText(/someone else must decide/)).toBeTruthy();
    expect(screen.getByText('$19.99')).toBeTruthy();
  });

  it('removes a row that is no longer pending', async () => {
    fail(409, 'pricing.hold.not-pending');
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, approve' }));
    await waitFor(() => expect(screen.queryByText('$19.99')).toBeNull());
  });

  it('offers no decision buttons without the decide permission', () => {
    mount(false);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('You can view this queue but not decide.')).toBeTruthy();
  });

  it('maps refusals to message keys', () => {
    expect(holdProblemOf({ status: 409, code: 'pricing.series-retired' }).key).toBe(
      'pricing.holds.error.retired',
    );
    expect(holdProblemOf({ status: 0, code: 'network' }).key).toBe(
      'pricing.holds.error.unavailable',
    );
    expect(holdProblemOf({ status: 500, code: 'x' }).key).toBe('pricing.holds.error.unknown');
  });

  it('shows the nav item only with pricing.price-hold.view', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('price-holds');
    expect(ids(['pricing.price-hold.view'])).toContain('price-holds');
  });
});
