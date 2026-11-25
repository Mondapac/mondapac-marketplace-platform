// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// The Details of a size on the one-page offer (Offer page PR 3): one row open at a time, Price
// and Stock tabs, and drafts typed in a row kept (and named) when its Details closes.

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import type { VariantPrice } from '../price/types.ts';
import type { SourceView } from '../stock/types.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

const source = (id: string, name: string): SourceView => ({
  id,
  name,
  isDefault: false,
  position: 0,
  address: null,
  timeZone: null,
  createdAt: '2026-10-01T00:00:00Z',
});
const price = (id: string, amount: string | null, over: Partial<VariantPrice> = {}) => ({
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
const row = (
  id: string,
  label: string,
  amount: string | null,
  onHand: number,
  held = 0,
  over: Partial<VariantPrice> = {},
): TableRow => ({
  variantId: id,
  label,
  price: price(id, amount, over),
  stock: { s1: { variantId: id, sourceId: 's1', onHand, held, version: 5, retired: false } },
});
const ROWS = [
  row('v1', '250 g', '950', 40),
  row('v2', '500 g', '1790', 25, 3, {
    held: { amount: '1890', submittedAt: '2026-11-20T00:00:00Z', direction: 'up' },
    special: {
      amount: '1590',
      startsAt: '2026-11-20T00:00:00Z',
      endsAt: '2026-11-30T00:00:00Z',
      state: 'running',
    },
  }),
];

function mount(over: Partial<Parameters<typeof VariantsTable>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
      <VariantsTable
        offerId="o1"
        rows={ROWS}
        sources={[source('s1', 'Warehouse')]}
        currency="AUD"
        canEditPrice
        canEditStock
        csrfToken="csrf"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}
// Each size has its button twice: under the size (phones) and in the last column (from 640 px);
// CSS shows one of them. jsdom has no media queries, so the tests press the first.
const details = (size: string) =>
  screen.getAllByRole('button', { name: `Details for ${size}` })[0]!;
const close = (size: string) =>
  screen.getAllByRole('button', { name: `Close details for ${size}` })[0]!;
const panel = (size: string) => screen.getByRole('group', { name: size });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('size Details', () => {
  it('opens one size at a time, in place, and says which one is open', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Sizes, prices and stock' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(details('250 g'));
    expect(close('250 g').getAttribute('aria-expanded')).toBe('true');
    expect(close('250 g').getAttribute('aria-controls')).toBe(panel('250 g').id);
    fireEvent.click(details('500 g'));
    expect(screen.queryByRole('group', { name: '250 g' })).toBeNull();
    expect(details('250 g').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    fireEvent.click(close('500 g'));
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows the price in force, a held price and the special price on the Price tab', () => {
    mount();
    fireEvent.click(details('500 g'));
    const open = within(panel('500 g'));
    expect(open.getByRole('tab', { name: 'Price' }).getAttribute('aria-selected')).toBe('true');
    expect(open.getByText('$17.90')).toBeTruthy();
    expect(open.getByText('Waiting for review')).toBeTruthy();
    expect(open.getByText('$18.90')).toBeTruthy();
    // Offer page PR 6: the special is set and ended here, not on the Prices page.
    expect(open.getByText('Running')).toBeTruthy();
    expect(open.getByText(/\$15\.90 until 30 Nov 2026/)).toBeTruthy();
    expect(open.getByText(/regular price of \$17\.90 crossed out/)).toBeTruthy();
    expect(open.getByRole('button', { name: 'End special price of 500 g' })).toBeTruthy();
    expect(open.getByRole('group', { name: 'Replace the special price' })).toBeTruthy();
    expect(open.queryByRole('link', { name: /special price/ })).toBeNull();
  });

  it('keeps a typed price when Details closes, names it, and still counts it for Save', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Price for 250 g'), { target: { value: '9.90' } });
    fireEvent.click(details('250 g'));
    expect(within(panel('250 g')).getByText('$9.90')).toBeTruthy();
    expect(within(panel('250 g')).getByText('Typed, not saved yet')).toBeTruthy();
    fireEvent.click(close('250 g'));
    fireEvent.click(details('500 g'));
    expect(screen.getByLabelText<HTMLInputElement>('Price for 250 g').value).toBe('9.90');
    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeTruthy();
  });

  it('shows held stock and the lowest stock the seller can set on the Stock tab', () => {
    mount();
    fireEvent.click(details('500 g'));
    const tab = within(panel('500 g')).getByRole('tab', { name: 'Stock' });
    fireEvent.click(tab);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const table = within(panel('500 g')).getByRole('table', { name: 'Stock of 500 g by location' });
    const cells = within(table).getAllByRole('row')[1]!.querySelectorAll('td');
    expect([...cells].map((cell) => cell.textContent)).toEqual([
      '25',
      '3held for checkouts and orders',
    ]);
    // The tab stays when another size opens.
    fireEvent.click(details('250 g'));
    expect(
      within(panel('250 g')).getByRole('tab', { name: 'Stock' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('names stock typed in the row and not saved yet', () => {
    mount();
    fireEvent.change(screen.getAllByLabelText('Units in stock at Warehouse')[0]!, {
      target: { value: '12' },
    });
    fireEvent.click(details('250 g'));
    fireEvent.click(within(panel('250 g')).getByRole('tab', { name: 'Stock' }));
    expect(within(panel('250 g')).getByText('Typed: 12, not saved yet')).toBeTruthy();
  });

  it('moves between the tabs with the arrow keys', () => {
    mount();
    fireEvent.click(details('250 g'));
    const price = within(panel('250 g')).getByRole('tab', { name: 'Price' });
    fireEvent.keyDown(price, { key: 'ArrowRight' });
    expect(
      within(panel('250 g')).getByRole('tab', { name: 'Stock' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('shows only the Stock tab without prices, and no Details with neither', () => {
    mount({ currency: null });
    fireEvent.click(details('250 g'));
    expect(
      within(panel('250 g'))
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Stock']);
    cleanup();
    mount({ currency: null, sources: [] });
    expect(screen.queryByRole('button', { name: /Details for/ })).toBeNull();
  });

  it('names a special waiting for review and when a scheduled one starts', () => {
    mount({
      rows: [
        row('v1', '250 g', '950', 40, 0, {
          special: {
            amount: '850',
            startsAt: '2026-12-01T00:00:00Z',
            endsAt: '2026-12-08T00:00:00Z',
            state: 'scheduled',
          },
          heldSpecial: {
            amount: '500',
            startsAt: '2026-12-10T00:00:00Z',
            endsAt: '2026-12-12T00:00:00Z',
            submittedAt: '2026-11-25T00:00:00Z',
          },
        }),
      ],
    });
    fireEvent.click(details('250 g'));
    const open = within(panel('250 g'));
    expect(open.getByText('Scheduled')).toBeTruthy();
    expect(open.getByText(/\$8\.50 from 1 Dec 2026.* until 8 Dec 2026/)).toBeTruthy();
    expect(open.getByText(/A special price of \$5\.00 \(10 Dec 2026/)).toBeTruthy();
    expect(open.getByRole('button', { name: 'Cancel scheduled special of 250 g' })).toBeTruthy();
    // The row says what customers pay and what is coming, in short.
    expect(screen.getByText('Special $8.50 from 1 Dec')).toBeTruthy();
    expect(screen.getByText('Special waiting for review')).toBeTruthy();
  });

  it('keeps the sizes card and its anchor for an offer with no sizes', () => {
    const { container } = mount({ rows: [] });
    expect(container.querySelector('#sizes')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Sizes, prices and stock' })).toBeTruthy();
  });

  it('saves while a row is open and keeps the row open', async () => {
    vi.mocked(callApi).mockResolvedValue({
      ok: true,
      status: 200,
      body: { stockItemId: 's', onHand: 12, version: 6, changed: true },
    });
    mount({ currency: null, canEditPrice: false });
    fireEvent.change(screen.getAllByLabelText('Units in stock at Warehouse')[0]!, {
      target: { value: '12' },
    });
    fireEvent.click(details('250 g'));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(callApi).toHaveBeenCalledTimes(1));
    expect(callApi).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o1/variants/v1/sources/s1/stock',
      { onHand: 12, expectedVersion: 5 },
      'csrf',
    );
    expect(close('250 g').getAttribute('aria-expanded')).toBe('true');
  });
});
