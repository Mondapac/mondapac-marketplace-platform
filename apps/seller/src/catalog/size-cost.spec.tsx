// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// The private Cost tab of a size (Offer page PR 7-UI): only with `pricing.cost.view`, hidden until
// "Show costs" (nothing is read before), typed as a draft and saved with "Save N changes" through
// the guarded Cost route, with "Estimated profit" from "You receive (est.)" at the price customers
// pay now.

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { ESTIMATE_DELAY_MS } from '../price/receive-estimates.ts';
import type { VariantPrice } from '../price/types.ts';
import { VariantsTable } from './variants-table.tsx';
import type { TableRow } from './variants-table-logic.ts';

const V1 = '01990000-0000-7000-8000-000000000001';
const V2 = '01990000-0000-7000-8000-000000000002';
const V3 = '01990000-0000-7000-8000-000000000003';
const call = vi.mocked(callApi);

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

/** The API stand-in: receive estimates at 15% commission, the Cost read and the Cost write. */
let costAnswer: unknown;
let writeAnswer: unknown;
function api(method: string, path: string) {
  if (path.includes('/receive-estimates')) {
    const query = decodeURIComponent(path.split('lines=')[1] ?? '');
    return {
      ok: true,
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
  if (method === 'GET' && path.endsWith('/costs')) return costAnswer;
  if (method === 'PUT' && path.endsWith('/cost')) return writeAnswer;
  return { ok: false, failure: { status: 500, code: 'internal' } };
}
const COSTS = {
  ok: true,
  status: 200,
  body: {
    offerId: 'o1',
    currency: 'AUD',
    variants: [
      { variantId: V1, seriesVersion: null, cost: null },
      { variantId: V2, seriesVersion: 4, cost: { amount: '900', currency: 'AUD' } },
      { variantId: V3, seriesVersion: null, cost: null },
    ],
  },
};

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
        canViewCost
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
const openCost = (size: string) => {
  fireEvent.click(screen.getAllByRole('button', { name: `Details for ${size}` })[0]!);
  fireEvent.click(screen.getByRole('tab', { name: 'Cost' }));
};
const costCalls = () => call.mock.calls.filter(([, path]) => /\/costs?$/.test(path));

beforeEach(() => {
  vi.useFakeTimers();
  call.mockReset();
  refresh.mockReset();
  costAnswer = COSTS;
  writeAnswer = { ok: true, status: 200, body: { status: 'recorded', seriesVersion: 5 } };
  call.mockImplementation((method, path) => Promise.resolve(api(method, path) as never));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Cost tab', () => {
  it('is there only for a seller with the Cost view key', () => {
    mount({ canViewCost: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Details for 500 g' })[0]!);
    expect(screen.queryByRole('tab', { name: 'Cost' })).toBeNull();
    cleanup();
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Details for 500 g' })[0]!);
    expect(screen.getByRole('tab', { name: 'Cost' })).toBeTruthy();
  });

  it('is hidden by default: nothing is read until "Show costs", and no Cost is in the table', async () => {
    mount();
    await flush();
    openCost('500 g');
    expect(screen.getByText('Private. Only people with cost access see this.')).toBeTruthy();
    expect(costCalls()).toHaveLength(0);
    expect(screen.queryByText('$9.00')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    expect(call).toHaveBeenCalledWith('GET', 'pricing/seller/offers/o1/costs');
    const field = screen.getByLabelText<HTMLInputElement>('Your cost (AUD, incl. GST) for 500 g');
    expect(field.value).toBe('9.00');
    // The Cost never lands in the table's rows.
    const table = screen.getByRole('table');
    expect(
      within(table.querySelector('tbody > tr') as HTMLElement).queryByText(/9\.00/),
    ).toBeNull();
  });

  it('shows Estimated profit at the price customers pay now (a running special)', async () => {
    mount();
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    // Customers pay 15.90 (special); receive 15.90 - 2.38 = 13.52; cost 9.00; profit 4.52 = 28%.
    const tab = within(screen.getByRole('tabpanel'));
    expect(tab.getByText('≈ $13.52')).toBeTruthy();
    expect(tab.getByText('− $9.00')).toBeTruthy();
    expect(screen.getByText('≈ $4.52')).toBeTruthy();
    expect(screen.getByText('(28% of $15.90)')).toBeTruthy();
  });

  it('follows a typed Cost before it is saved, and names a loss', async () => {
    mount();
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    fireEvent.change(screen.getByLabelText('Your cost (AUD, incl. GST) for 500 g'), {
      target: { value: '15' },
    });
    expect(screen.getByText('≈ -$1.48')).toBeTruthy();
    expect(screen.getByText('Your cost is more than you receive at this price.')).toBeTruthy();
    expect(screen.getByText('Typed, not saved yet. Saved with your other changes.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save 1 change' })).toBeTruthy();
  });

  it('saves a typed Cost with "Save N changes" through the Cost route, then reads Costs again', async () => {
    mount();
    await flush();
    openCost('250 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    fireEvent.change(screen.getByLabelText('Your cost (AUD, incl. GST) for 250 g'), {
      target: { value: '6.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await flush();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `pricing/seller/offers/o1/variants/${V1}/cost`,
      { cost: { amount: '650', currency: 'AUD' }, expectedVersion: null },
      'csrf',
    );
    // Read again for fresh versions: one read on Show, one after the save.
    expect(costCalls().filter(([method]) => method === 'GET')).toHaveLength(2);
  });

  it('clears a Cost when the field is emptied, with the version read', async () => {
    mount();
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    fireEvent.change(screen.getByLabelText('Your cost (AUD, incl. GST) for 500 g'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await flush();
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `pricing/seller/offers/o1/variants/${V2}/cost`,
      { cost: null, expectedVersion: 4 },
      'csrf',
    );
  });

  it('refuses text that is not money on the field, and opens its Cost tab', async () => {
    mount();
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    fireEvent.change(screen.getByLabelText('Your cost (AUD, incl. GST) for 500 g'), {
      target: { value: '9.999' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await flush();
    expect(screen.getByRole('tab', { name: 'Cost' }).getAttribute('aria-selected')).toBe('true');
    expect(
      screen.getByText('Enter a cost above zero, with at most the decimals the currency allows.'),
    ).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('shows a refused Cost write on its field without the amount', async () => {
    writeAnswer = { ok: false, failure: { status: 422, code: 'pricing.amount-out-of-range' } };
    mount();
    await flush();
    openCost('250 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    fireEvent.change(screen.getByLabelText('Your cost (AUD, incl. GST) for 250 g'), {
      target: { value: '7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await flush();
    expect(screen.getByText('This cost is outside the allowed range.')).toBeTruthy();
  });

  it('"Hide costs" waits for typed Costs, then hides them all again', async () => {
    mount();
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    const field = screen.getByLabelText('Your cost (AUD, incl. GST) for 500 g');
    fireEvent.change(field, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide costs' }));
    expect(screen.getByText('Save or discard your cost changes first.')).toBeTruthy();
    expect(screen.getByLabelText('Your cost (AUD, incl. GST) for 500 g')).toBeTruthy();

    fireEvent.change(field, { target: { value: '9.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide costs' }));
    expect(screen.queryByLabelText('Your cost (AUD, incl. GST) for 500 g')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show costs' })).toBeTruthy();
    expect(screen.queryByText('− $9.00')).toBeNull();
  });

  it('says why costs are not shown while signed in as the seller', async () => {
    costAnswer = { ok: false, failure: { status: 403, code: 'pricing.acting-as-refused' } };
    mount();
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    expect(screen.getByText(/aren’t shown while you’re signed in as the seller/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the Cost read-only to a seller who may not change prices, with no Save', async () => {
    mount({ canEditPrice: false });
    await flush();
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    expect(screen.queryByLabelText('Your cost (AUD, incl. GST) for 500 g')).toBeNull();
    expect(screen.getByText('$9.00')).toBeTruthy();
    expect(screen.getByText('≈ $4.52')).toBeTruthy();
    expect(screen.getByText('Only people who can change prices can change the cost.')).toBeTruthy();
  });

  it('without "You receive (est.)" says why and shows no profit', async () => {
    mount({ canEstimate: false });
    openCost('500 g');
    fireEvent.click(screen.getByRole('button', { name: 'Show costs' }));
    await flush();
    expect(screen.getByText('Your role can’t see what you receive')).toBeTruthy();
    expect(screen.queryByText(/≈/)).toBeNull();
  });
});
