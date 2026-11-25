// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// "Typical price" (Offer page PR 9-UI): the range other businesses sell a size in, only when the
// API gives one, with a note beside the price field when the price is outside it. It informs; the
// price still saves.

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import type { VariantPrice } from '../price/types.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

const V1 = '01990000-0000-7000-8000-000000000001';
const V2 = '01990000-0000-7000-8000-000000000002';
const call = vi.mocked(callApi);

const price = (id: string, amount: string): VariantPrice => ({
  variantId: id,
  seriesVersion: 3,
  currency: 'AUD',
  inForce: { amount, effectiveFrom: '2026-01-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired: false,
});
const row = (id: string, label: string, amount: string) =>
  ({ variantId: id, label, price: price(id, amount), stock: {} }) as TableRow;
// 250 g sells at $9.50 inside 8.90 to 27.00; 500 g has no range (too few sellers).
const ROWS = [row(V1, '250 g', '950'), row(V2, '500 g', '1790')];

let answer: unknown;
const typicalCalls = () => call.mock.calls.filter(([, path]) => /typical-prices$/.test(path));

function mount(over: Partial<Parameters<typeof VariantsTable>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
      <VariantsTable
        offerId="o1"
        rows={ROWS}
        sources={[]}
        currency="AUD"
        canEditPrice
        canEditStock={false}
        csrfToken="csrf"
        canViewTypical
        {...over}
      />
    </NextIntlClientProvider>,
  );
}
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const priceField = (size: string) => screen.getByRole('textbox', { name: `Price for ${size}` });
const openDetails = (size: string) =>
  fireEvent.click(screen.getAllByRole('button', { name: `Details for ${size}` })[0]!);

beforeEach(() => {
  call.mockReset();
  answer = {
    ok: true,
    status: 200,
    body: {
      offerId: 'o1',
      variants: [
        { variantId: V1, range: { lowMinor: '890', highMinor: '2700' } },
        { variantId: V2, range: null },
      ],
    },
  };
  call.mockImplementation(() => Promise.resolve(answer as never));
});
afterEach(cleanup);

describe('Typical price', () => {
  it('reads nothing without the price view key', async () => {
    mount({ canViewTypical: false });
    await settle();
    expect(typicalCalls()).toHaveLength(0);
  });

  it('reads the ranges once and shows the range of a size that has one in its Price tab', async () => {
    mount();
    await settle();
    expect(typicalCalls()).toHaveLength(1);
    openDetails('250 g');
    expect(screen.getByText('Typical price')).toBeTruthy();
    expect(screen.getByText('$8.90 to $27.00')).toBeTruthy();
    expect(screen.queryByText(/lower than the typical price/)).toBeNull();
  });

  it('shows nothing for a size without a range, and no reason why', async () => {
    mount();
    await settle();
    openDetails('500 g');
    expect(screen.queryByText('Typical price')).toBeNull();
  });

  it('shows nothing when the read fails, and the page works as before', async () => {
    answer = { ok: false, failure: { status: 503, code: 'access.unavailable' } };
    mount();
    await settle();
    openDetails('250 g');
    expect(screen.queryByText('Typical price')).toBeNull();
    expect(priceField('250 g')).toBeTruthy();
  });

  it('notes a typed price above or below the range beside the field, and in Details', async () => {
    mount();
    await settle();
    fireEvent.change(priceField('250 g'), { target: { value: '40.00' } });
    expect(screen.getByText('Above typical')).toBeTruthy();
    openDetails('250 g');
    expect(
      screen.getByText('Your price is higher than the typical price. You can still save it.'),
    ).toBeTruthy();
    fireEvent.change(priceField('250 g'), { target: { value: '5.00' } });
    expect(screen.getByText('Below typical')).toBeTruthy();
    fireEvent.change(priceField('250 g'), { target: { value: '12.50' } });
    expect(screen.queryByText(/than typical/)).toBeNull();
  });

  it('does not stop a save: the note is not an error and the field stays valid', async () => {
    mount();
    await settle();
    fireEvent.change(priceField('250 g'), { target: { value: '40.00' } });
    expect(priceField('250 g').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.getByRole('button', { name: /^Save 1 change/ })).toBeTruthy();
  });

  it('is quiet for a size with no range however the price is typed', async () => {
    mount();
    await settle();
    fireEvent.change(priceField('500 g'), { target: { value: '999.00' } });
    expect(screen.queryByText(/than typical/)).toBeNull();
  });

  it('shows no range for a size no longer sold', async () => {
    const retired = {
      ...ROWS[0]!,
      price: { ...price(V1, '950'), retired: true },
    } as TableRow;
    mount({ rows: [retired, ROWS[1]!] });
    await settle();
    openDetails('250 g');
    expect(screen.queryByText('Typical price')).toBeNull();
  });
});
