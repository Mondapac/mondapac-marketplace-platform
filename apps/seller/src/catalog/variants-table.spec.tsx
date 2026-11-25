// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import type { VariantPrice } from '../price/types.ts';
import type { SourceView } from '../stock/types.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

const call = vi.mocked(callApi);
const source = (id: string, name: string): SourceView => ({
  id,
  name,
  isDefault: false,
  position: 0,
  address: null,
  timeZone: null,
  createdAt: '2026-10-01T00:00:00Z',
});
const price = (
  id: string,
  amount: string | null,
  over: Partial<VariantPrice> = {},
): VariantPrice => ({
  variantId: id,
  seriesVersion: amount === null ? null : 3,
  currency: 'AUD',
  inForce: amount === null ? null : { amount, effectiveFrom: '2026-01-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
  ...over,
});
const row = (id: string, label: string, amount: string | null, onHand: number): TableRow => ({
  variantId: id,
  label,
  price: price(id, amount),
  stock: { s1: { variantId: id, sourceId: 's1', onHand, held: 0, version: 5, retired: false } },
});
const ROWS = [
  row('v1', 'Small', '1000', 4),
  row('v2', 'Large', '2000', 9),
  row('v3', 'Huge', null, 0),
];

function mount(
  over: Partial<Parameters<typeof VariantsTable>[0]> = {},
  sources: SourceView[] = [source('s1', 'Warehouse')],
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <VariantsTable
        offerId="o1"
        rows={ROWS}
        sources={sources}
        currency="AUD"
        canEditPrice
        canEditStock
        csrfToken="csrf"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}
const priceBox = (label: string) => screen.getByLabelText<HTMLInputElement>(`Price for ${label}`);
const stockBox = (index = 0) =>
  screen.getAllByLabelText('Units in stock at Warehouse')[index] as HTMLInputElement;
const pick = (label: string) =>
  fireEvent.click(screen.getByRole('checkbox', { name: `Select ${label}` }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('VariantsTable', () => {
  it('shows price, special price and stock of every variant', () => {
    mount({
      rows: [
        {
          ...ROWS[0]!,
          price: price('v1', '1000', {
            special: { amount: '800', startsAt: 'a', endsAt: 'b', state: 'running' },
          }),
        },
        ROWS[1]!,
      ],
    });
    expect(priceBox('Small').value).toBe('10.00');
    expect(screen.getByText('$8.00, running')).toBeTruthy();
    expect(stockBox(0).value).toBe('4');
    expect(stockBox(1).value).toBe('9');
  });

  it('sets one price for the selected variants and saves one write each, with the version', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
    });
    mount();
    pick('Small');
    pick('Large');
    fireEvent.click(screen.getByRole('button', { name: 'Set price' }));
    fireEvent.change(screen.getByLabelText(/New price/), { target: { value: '15.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 variants' }));
    expect(priceBox('Small').value).toBe('15.50');
    expect(priceBox('Huge').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/regular-price',
      { amount: '1550', currency: 'AUD', expectedVersion: 3 },
      'csrf',
    );
    await expectToast('Saved 2 changes.');
    expect(refresh).toHaveBeenCalled();
  });

  it('increases the price in force by a percent and leaves a variant with no price', () => {
    mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all variants' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase by %' }));
    fireEvent.change(screen.getByLabelText('Increase prices by (%)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 3 variants' }));
    expect(priceBox('Small').value).toBe('11.00');
    expect(priceBox('Large').value).toBe('22.00');
    expect(priceBox('Huge').value).toBe('');
    expect(screen.getByText(/1 variant has no price yet/)).toBeTruthy();
  });

  it('sets stock at the chosen location for the selected variants', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { stockItemId: 'i', onHand: 20, version: 6, changed: true },
    });
    mount({}, [source('s1', 'Warehouse'), source('s2', 'Shop')]);
    pick('Small');
    fireEvent.click(screen.getByRole('button', { name: 'Set stock' }));
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 's2' } });
    fireEvent.change(
      within(screen.getByRole('group', { name: 'Bulk actions' })).getByLabelText('Units in stock'),
      { target: { value: '20' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 variant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o1/variants/v1/sources/s2/stock',
      { onHand: 20, expectedVersion: null },
      'csrf',
    );
  });

  it('sends only the cells that changed and nothing for an invalid one', () => {
    mount();
    fireEvent.change(priceBox('Small'), { target: { value: '1.999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(priceBox('Small'), { target: { value: '10.00' } });
    // Back to the saved price: nothing to save, so the bar goes away.
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('shows why a write failed on its cell and keeps the draft, while the others are saved', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
      })
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    mount();
    fireEvent.change(priceBox('Small'), { target: { value: '11' } });
    fireEvent.change(priceBox('Large'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    expect(await screen.findByText(/The price changed somewhere else/)).toBeTruthy();
    expect(priceBox('Large').value).toBe('22');
    await expectToast('Saved 1, 1 could not be saved. The cells that failed show why.', 'info');
  });

  it('applies the bulk value on Enter without saving the table', () => {
    mount();
    pick('Small');
    fireEvent.click(screen.getByRole('button', { name: 'Set price' }));
    const field = screen.getByLabelText(/New price/);
    fireEvent.change(field, { target: { value: '15.50' } });
    // A cancelled keydown means the browser does not submit the form.
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    expect(priceBox('Small').value).toBe('15.50');
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the save bar with the change count, and Discard drops every draft', () => {
    mount();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.change(priceBox('Small'), { target: { value: '12.00' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('1 unsaved change');
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(priceBox('Small').value).toBe('10.00');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('shows the bar for an invalid price, and Save then marks the cell and sends nothing', () => {
    mount();
    fireEvent.change(priceBox('Small'), { target: { value: 'abc' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Save 1 change' }));
    expect(call).not.toHaveBeenCalled();
    expect(priceBox('Small').getAttribute('aria-invalid')).toBe('true');
  });

  it('saves the table when its form is submitted (the Save button)', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: null },
    });
    mount();
    fireEvent.change(priceBox('Small'), { target: { value: '12.00' } });
    fireEvent.submit(priceBox('Small').closest('form')!);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });

  it('moves down the column on Enter, up on Shift+Enter, and never saves on Enter', () => {
    mount();
    priceBox('Small').focus();
    expect(fireEvent.keyDown(priceBox('Small'), { key: 'Enter' })).toBe(false);
    expect(document.activeElement).toBe(priceBox('Large'));
    fireEvent.keyDown(priceBox('Large'), { key: 'Enter' });
    expect(document.activeElement).toBe(priceBox('Huge'));
    fireEvent.keyDown(priceBox('Huge'), { key: 'Enter', shiftKey: true });
    expect(document.activeElement).toBe(priceBox('Large'));
    stockBox(0).focus();
    fireEvent.keyDown(stockBox(0), { key: 'Enter' });
    expect(document.activeElement).toBe(stockBox(1));
    // The last row stays where it is, and nothing is sent.
    fireEvent.keyDown(priceBox('Huge'), { key: 'Enter' });
    expect(call).not.toHaveBeenCalled();
  });

  it('leaves Enter to an input method that is still composing', () => {
    mount();
    priceBox('Small').focus();
    fireEvent.keyDown(priceBox('Small'), { key: 'Enter', keyCode: 229 });
    expect(document.activeElement).toBe(priceBox('Small'));
  });

  it('puts the cursor on the first empty price of a new draft', () => {
    mount({ focusPrice: true });
    expect(document.activeElement).toBe(priceBox('Huge'));
  });

  it('asks before the page unloads while drafts are unsaved', () => {
    mount();
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    fireEvent.change(priceBox('Small'), { target: { value: '12.00' } });
    const asked = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asked);
    expect(asked.defaultPrevented).toBe(true);
  });

  it('is read only without edit permissions', () => {
    mount({ canEditPrice: false, canEditStock: false });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
    expect(screen.getByText('$10.00')).toBeTruthy();
  });

  it('shows no price columns when the seller may not see prices', () => {
    mount({ currency: null, rows: ROWS.map((r) => ({ ...r, price: null })) });
    expect(screen.queryByText('Special price')).toBeNull();
    expect(screen.getByText('Large')).toBeTruthy();
  });
});
