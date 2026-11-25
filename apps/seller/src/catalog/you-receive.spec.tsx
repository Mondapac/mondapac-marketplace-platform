// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// "You receive (est.)" on the one-page offer (Offer page PR 4): a column in the sizes table and
// three lines in the Price tab, read from the API for what a customer pays now (a running special,
// the typed price, else the saved one), after a short pause while the seller types. No rate and no
// platform name are shown; a failed read shows no money.

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import {
  canEstimateReceive,
  customerPaysMinor,
  ESTIMATE_DELAY_MS,
  linesQuery,
} from '../price/receive-estimates.ts';
import type { VariantPrice } from '../price/types.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

const V1 = '01990000-0000-7000-8000-000000000001';
const V2 = '01990000-0000-7000-8000-000000000002';
const V3 = '01990000-0000-7000-8000-000000000003';

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
const row = (id: string, label: string, amount: string | null, over: Partial<VariantPrice> = {}) =>
  ({ variantId: id, label, price: price(id, amount, over), stock: {} }) as TableRow;
const ROWS = [
  row(V1, '250 g', '950'),
  row(V2, '500 g', '1790', {
    special: {
      amount: '1590',
      startsAt: '2026-11-20T00:00:00Z',
      endsAt: '2026-11-30T00:00:00Z',
      state: 'running',
    },
  }),
  row(V3, '1 kg', null),
];

/** The API stand-in: 15% commission, prices include tax. */
function answer(path: string) {
  const query = decodeURIComponent(path.split('lines=')[1] ?? '');
  return {
    ok: true as const,
    status: 200,
    body: {
      offerId: 'o1',
      currency: 'AUD',
      taxInclusive: true,
      lines: query.split(',').map((pair) => {
        const [variantId, minor] = pair.split(':') as [string, string];
        const commission = (BigInt(minor) * 15n) / 100n;
        return {
          variantId,
          priceMinor: minor,
          commissionMinor: commission.toString(),
          youReceiveMinor: (BigInt(minor) - commission).toString(),
        };
      }),
    },
  };
}

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
        canEstimate
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ESTIMATE_DELAY_MS + 10);
  });
};
const cellOf = (size: string) => {
  const tableRow = screen.getByRole('rowheader', { name: new RegExp(size) }).closest('tr')!;
  const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
  const column = headers.indexOf('You receive (est.)');
  return tableRow.querySelectorAll('td, th')[column]!;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(callApi).mockReset();
  vi.mocked(callApi).mockImplementation((_method, path) => Promise.resolve(answer(path) as never));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('customerPaysMinor and linesQuery', () => {
  it('takes a running special first, then a typed amount, then the saved price', () => {
    const special = price(V1, '1790', {
      special: { amount: '1590', startsAt: 'x', endsAt: 'y', state: 'running' },
    });
    expect(customerPaysMinor(special, '20.00', 'AUD')).toBe('1590');
    const scheduled = price(V1, '1790', {
      special: { amount: '1590', startsAt: 'x', endsAt: 'y', state: 'scheduled' },
    });
    expect(customerPaysMinor(scheduled, undefined, 'AUD')).toBe('1790');
    expect(customerPaysMinor(price(V1, '1790'), '18.5', 'AUD')).toBe('1850');
    expect(customerPaysMinor(price(V1, '1790'), '18.', 'AUD')).toBeNull();
    expect(customerPaysMinor(price(V1, '1790'), ' ', 'AUD')).toBeNull();
    expect(customerPaysMinor(price(V1, null), undefined, 'AUD')).toBeNull();
    expect(customerPaysMinor(price(V1, '1790', { retired: true }), undefined, 'AUD')).toBeNull();
    expect(customerPaysMinor(price(V1, '1790'), '1790', 'JPY')).toBe('1790');
  });

  it('builds a sorted query of the sizes that have an amount', () => {
    expect(linesQuery({ [V2]: '1590', [V3]: null, [V1]: '950' })).toBe(`${V1}:950,${V2}:1590`);
    expect(linesQuery({ [V3]: null })).toBe('');
  });

  it('needs the price view key and the seller ledger key', () => {
    expect(canEstimateReceive(['pricing.price.view', 'commission-payouts.earnings.view'])).toBe(
      true,
    );
    expect(canEstimateReceive(['pricing.price.view'])).toBe(false);
    expect(canEstimateReceive(['commission-payouts.earnings.view'])).toBe(false);
  });
});

describe('You receive (est.) in the sizes table', () => {
  it('reads one estimate for all sizes and shows "≈ amount" per row, a dash without a price', async () => {
    mount();
    await flush();

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi).toHaveBeenCalledWith(
      'GET',
      `pricing/seller/offers/o1/receive-estimates?lines=${encodeURIComponent(`${V1}:950,${V2}:1590`)}`,
      undefined,
      undefined,
      expect.any(AbortSignal),
    );
    expect(cellOf('250 g').textContent).toBe('≈ $8.08');
    // The running special is what customers pay now.
    expect(cellOf('500 g').textContent).toBe('≈ $13.52');
    expect(cellOf('1 kg').textContent).toBe('—');
    expect(screen.getByText(/They are not counted in “You receive”/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/MondaPac|%/);
  });

  it('reads again once, after a pause, for a typed price, and hides the old number meanwhile', async () => {
    mount();
    await flush();
    vi.mocked(callApi).mockClear();

    const field = screen.getByRole('textbox', { name: 'Price for 250 g' });
    fireEvent.change(field, { target: { value: '1' } });
    fireEvent.change(field, { target: { value: '12' } });
    fireEvent.change(field, { target: { value: '12.00' } });
    expect(cellOf('250 g').textContent).toBe('—');
    await flush();

    expect(callApi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callApi).mock.calls[0]?.[1]).toContain(encodeURIComponent(`${V1}:1200`));
    expect(cellOf('250 g').textContent).toBe('≈ $10.20');
  });

  it('shows no money and says so when the read fails', async () => {
    vi.mocked(callApi).mockResolvedValue({
      ok: false,
      failure: { status: 503, code: 'pricing.estimate-unavailable' },
    } as never);
    mount();
    await flush();

    expect(cellOf('250 g').textContent).toBe('—');
    expect(screen.getByText(/can’t be worked out right now/)).toBeTruthy();
  });

  it('reads nothing and shows no column without the keys', async () => {
    mount({ canEstimate: false });
    await flush();

    expect(callApi).not.toHaveBeenCalled();
    expect(screen.queryByRole('columnheader', { name: 'You receive (est.)' })).toBeNull();
    expect(screen.queryByText(/not counted in “You receive”/)).toBeNull();
  });
});

describe('What you receive in the Price tab', () => {
  const open = (size: string) =>
    fireEvent.click(screen.getAllByRole('button', { name: `Details for ${size}` })[0]!);

  it('shows customer pays, the commission and You receive (est.) with the note', async () => {
    mount();
    await flush();
    open('500 g');

    const group = within(screen.getByRole('region', { name: 'What you receive' }));
    const text = (label: string) =>
      group.getByText(label).closest('div')!.querySelector('dd')!.textContent;
    expect(text('Customer pays')).toBe('$15.90Special price, running');
    expect(text('Platform commission')).toBe('− $2.38');
    expect(text('You receive (est.)')).toBe('≈ $13.52');
    expect(group.getByText(/The most the commission can be/)).toBeTruthy();
  });

  it('names a typed price and asks for a price when there is none', async () => {
    mount();
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Price for 250 g' }), {
      target: { value: '10' },
    });
    open('250 g');
    expect(screen.getByText('Working it out…')).toBeTruthy();
    await flush();
    const group = within(screen.getByRole('region', { name: 'What you receive' }));
    expect(group.getByText('The price you typed, not saved yet')).toBeTruthy();

    open('1 kg');
    expect(
      within(screen.getByRole('region', { name: 'What you receive' })).getByText(
        'Set a price to see what you receive.',
      ),
    ).toBeTruthy();
  });
});
