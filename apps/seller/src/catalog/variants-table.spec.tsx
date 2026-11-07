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
  variantSku: '',
  selling: true,
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
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(priceBox('Small'), { target: { value: '10.00' } });
    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      true,
    );
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

  it('saves the SKU and the selling switch of the changed variants in one call', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changedVariantIds: ['v1', 'v2'] } });
    mount({ showSellUnits: true, canEditSellUnits: true });
    fireEvent.change(screen.getByLabelText('SKU for Small'), { target: { value: 'SM-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Large is on sale' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'catalog/seller/offers/o1/sell-units',
      {
        units: [
          { variantId: 'v1', variantSku: 'SM-1' },
          { variantId: 'v2', selling: false },
        ],
      },
      'csrf',
    );
    await expectToast('Saved 2 changes.');
  });

  it('refuses an invalid SKU on its cell without a call, and shows a taken SKU from the server', async () => {
    mount({ showSellUnits: true, canEditSellUnits: true });
    fireEvent.change(screen.getByLabelText('SKU for Small'), { target: { value: 'has space' } });
    // An invalid SKU is no write: the button stays off and nothing is sent.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      true,
    );
    expect(call).not.toHaveBeenCalled();
    cleanup();
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 409,
        code: 'offer.sku-taken',
        details: { fields: [{ path: 'units.v1', code: 'taken' }] },
      },
    });
    mount({ showSellUnits: true, canEditSellUnits: true });
    fireEvent.change(screen.getByLabelText('SKU for Small'), { target: { value: 'TAKEN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(await screen.findByText(/already used by another variant/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('SKU for Small').value).toBe('TAKEN');
  });

  it('shows the SKU and the switch read only without the edit key', () => {
    mount({
      showSellUnits: true,
      canEditSellUnits: false,
      rows: [{ ...ROWS[0]!, variantSku: 'SM-1', selling: false }],
    });
    expect(screen.getByText('SM-1')).toBeTruthy();
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Small is on sale' });
    expect([box.disabled, box.checked]).toEqual([true, false]);
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
