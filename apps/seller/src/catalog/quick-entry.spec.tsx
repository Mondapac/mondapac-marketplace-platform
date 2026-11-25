// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }));

import { callApi } from '../api/client.ts';
import type { SourceView } from '../stock/types.ts';
import { expectToast } from '../../test/toast-spy.ts';
import { QuickEntryTable } from './quick-entry.tsx';
import type { QuickGroup } from './quick-entry-logic.ts';
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
const row = (id: string, label: string, amount: string | null = null): TableRow => ({
  variantId: id,
  label,
  price: {
    variantId: id,
    seriesVersion: amount === null ? null : 2,
    currency: 'AUD',
    inForce: amount === null ? null : { amount, effectiveFrom: '2026-01-01T00:00:00Z' },
    held: null,
    special: null,
    heldSpecial: null,
    retired: false,
  },
  stock: {},
});
const group = (offerId: string, name: string, rows: TableRow[]): QuickGroup => ({
  offerId,
  name,
  productCode: `P-${offerId}`,
  thumb: null,
  conditionCode: 'new',
  handling: 'SEALED_ORIGINAL',
  rows,
});
const GROUPS = [
  group('o1', 'Beef brisket', [row('a1', '1 kg')]),
  group('o2', 'Beef mince', [row('b1', '250 g'), row('b2', '500 g'), row('b3', '1 kg')]),
];

function mount(over: Partial<Parameters<typeof QuickEntryTable>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <QuickEntryTable
        groups={GROUPS}
        unreadable={0}
        more={0}
        sources={[source('s1', 'Shop')]}
        currency="AUD"
        canEditPrice
        canEditStock
        canEstimate={false}
        csrfToken="csrf"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}
const priceBox = (product: string, size: string) =>
  screen.getByLabelText<HTMLInputElement>(`Price for ${product}, ${size}`);
const stockBox = (product: string, size: string) =>
  screen.getByLabelText<HTMLInputElement>(`Stock of ${product}, ${size}, at Shop`);
const statusOf = (product: string, size: string) =>
  within(priceBox(product, size).closest('tr') as HTMLElement).getAllByText(
    /Ready|Needs price|Needs stock|Check price|Out of stock/,
  )[0]?.textContent;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('QuickEntryTable', () => {
  it('shows every size of every new draft, with the cursor on the first price', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'New offers · 2 products, 4 sizes' })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(5);
    expect(document.activeElement).toBe(priceBox('Beef brisket', '1 kg'));
    expect(statusOf('Beef mince', '500 g')).toBe('Needs price');
  });

  it('moves down across products on Enter and follows the typed values in Status', () => {
    mount();
    const first = priceBox('Beef brisket', '1 kg');
    fireEvent.change(first, { target: { value: '32' } });
    expect(statusOf('Beef brisket', '1 kg')).toBe('Needs stock');
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(priceBox('Beef mince', '250 g'));
    fireEvent.change(stockBox('Beef brisket', '1 kg'), { target: { value: '12' } });
    expect(statusOf('Beef brisket', '1 kg')).toBe('Ready');
    fireEvent.change(priceBox('Beef mince', '250 g'), { target: { value: 'x' } });
    expect(statusOf('Beef mince', '250 g')).toBe('Check price');
    expect(screen.getByText(/1 of 4 sizes have a price and stock/)).toBeTruthy();
  });

  it('fills the stock of one product on "Apply to all sizes", and saves nothing', () => {
    mount();
    // The strip follows the product the seller is typing in.
    fireEvent.focus(priceBox('Beef mince', '500 g'));
    fireEvent.change(screen.getByLabelText('Stock for all sizes'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all sizes' }));
    expect(stockBox('Beef mince', '250 g').value).toBe('20');
    expect(stockBox('Beef mince', '1 kg').value).toBe('20');
    expect(stockBox('Beef brisket', '1 kg').value).toBe('');
    expect(screen.getByText(/Filled the stock of 3 sizes of Beef mince/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('says the condition and handling of the product, with a link to change them', () => {
    mount();
    expect(screen.getByText(/Condition: New · Handling: Sealed original\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change for Beef brisket' }).getAttribute('href')).toBe(
      '/offers/o1/edit',
    );
  });

  it('saves each changed cell through the route of its own offer', async () => {
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path.startsWith('pricing')
          ? {
              ok: true as const,
              status: 200,
              body: { status: 'accepted', seriesVersion: 1, recordId: 'r', effectiveFrom: null },
            }
          : { ok: true as const, status: 200, body: { version: 1 } },
      ),
    );
    mount();
    fireEvent.change(priceBox('Beef brisket', '1 kg'), { target: { value: '32.00' } });
    fireEvent.change(stockBox('Beef mince', '1 kg'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/a1/regular-price',
      { amount: '3200', currency: 'AUD', expectedVersion: null },
      'csrf',
    );
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o2/variants/b3/sources/s1/stock',
      { onHand: 5, expectedVersion: null },
      'csrf',
    );
    await expectToast('Saved 2 changes.');
    expect(refresh).toHaveBeenCalled();
  });

  it('marks a cell the server refused and keeps it as a draft', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 422, code: 'validation.failed' },
    } as never);
    mount();
    fireEvent.change(priceBox('Beef brisket', '1 kg'), { target: { value: '32.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() =>
      expect(priceBox('Beef brisket', '1 kg').getAttribute('aria-invalid')).toBe('true'),
    );
    expect(priceBox('Beef brisket', '1 kg').value).toBe('32.00');
  });

  it('"Save drafts" saves first, then opens the Drafts tab', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save drafts' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/offers?view=drafts'));
    expect(call).not.toHaveBeenCalled();
  });

  it('asks to save or discard before a new search leaves the page', async () => {
    mount();
    fireEvent.change(priceBox('Beef brisket', '1 kg'), { target: { value: '32.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to search' }));
    await expectToast('Save or discard your changes first, then search again.', 'info');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the price field with the currency sign', () => {
    mount();
    expect(screen.getAllByText('$').length).toBeGreaterThan(0);
  });

  it('points to Drafts for the drafts it does not show', () => {
    mount({ more: 2, unreadable: 1 });
    expect(
      screen.getByText('3 more new drafts are not in this table. They are waiting in Drafts.'),
    ).toBeTruthy();
  });

  it('is read only without the edit keys', () => {
    mount({ canEditPrice: false, canEditStock: false });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save \d/ })).toBeNull();
  });
});
