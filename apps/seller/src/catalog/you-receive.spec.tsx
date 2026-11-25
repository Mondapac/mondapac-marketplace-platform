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
import { canEstimateReceive } from '../price/receive-permissions.ts';
import { customerPaysMinor, ESTIMATE_DELAY_MS, linesQueries } from '../price/receive-estimates.ts';
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
let taxInclusive = true;
function answer(path: string) {
  const query = decodeURIComponent(path.split('lines=')[1] ?? '');
  return {
    ok: true as const,
    status: 200,
    body: {
      offerId: 'o1',
      currency: 'AUD',
      taxInclusive,
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
  taxInclusive = true;
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

  it('builds sorted queries of the sizes that have an amount, 20 sizes each', () => {
    expect(linesQueries({ [V2]: '1590', [V3]: null, [V1]: '950' })).toEqual([
      `${V1}:950,${V2}:1590`,
    ]);
    expect(linesQueries({ [V3]: null })).toEqual([]);
    const many = Object.fromEntries(
      Array.from({ length: 45 }, (_, n) => [`v${String(n).padStart(2, '0')}`, '100']),
    );
    const queries = linesQueries(many);
    expect(queries.map((query) => query.split(',').length)).toEqual([20, 20, 5]);
    expect(queries[2]).toBe('v40:100,v41:100,v42:100,v43:100,v44:100');
  });

  it('shows no estimate for a typed price above what the API takes', () => {
    expect(customerPaysMinor(price(V1, '1790'), '10000000000', 'AUD')).toBe('1000000000000');
    expect(customerPaysMinor(price(V1, '1790'), '10000000000.01', 'AUD')).toBeNull();
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

  it('reads again once, after a pause, for a typed price', async () => {
    mount();
    await flush();
    vi.mocked(callApi).mockClear();

    const field = screen.getByRole('textbox', { name: 'Price for 250 g' });
    fireEvent.change(field, { target: { value: '1' } });
    fireEvent.change(field, { target: { value: '12' } });
    fireEvent.change(field, { target: { value: '12.00' } });
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

  it('keeps the last number, muted, while a typed price is read', async () => {
    mount();
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Price for 250 g' }), {
      target: { value: '12.00' },
    });
    const pending = cellOf('250 g').querySelector('[aria-busy="true"]');
    expect(pending?.textContent).toBe('≈ $8.08');
    expect(pending?.className).toContain('text-fg-muted');
    await flush();
    expect(cellOf('250 g').textContent).toBe('≈ $10.20');
    expect(cellOf('250 g').querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('drops an answer for amounts the page no longer shows', async () => {
    let release: (value: unknown) => void = () => undefined;
    vi.mocked(callApi).mockImplementationOnce(
      (_method, path) =>
        new Promise((resolve) => {
          release = () => resolve(answer(path));
        }),
    );
    mount();
    await flush();
    // The first read is still on its way when the seller types a new price.
    fireEvent.change(screen.getByRole('textbox', { name: 'Price for 250 g' }), {
      target: { value: '12.00' },
    });
    await flush();
    await act(async () => {
      release(null);
      await Promise.resolve();
    });
    expect(cellOf('250 g').textContent).toBe('≈ $10.20');
  });

  it('reads an Offer with more than 20 sizes in several requests and shows every size', async () => {
    const many = Array.from({ length: 23 }, (_, n) =>
      row(`01990000-0000-7000-8000-${String(n + 100).padStart(12, '0')}`, `${n + 1} pack`, '1000'),
    );
    mount({ rows: many });
    await flush();
    expect(callApi).toHaveBeenCalledTimes(2);
    expect(cellOf('23 pack').textContent).toBe('≈ $8.50');
  });

  it('says prices are before tax when the Market says so', async () => {
    taxInclusive = false;
    mount();
    await flush();
    expect(cellOf('250 g').textContent).toBe('≈ $8.08before tax');
    expect(screen.getByText('Prices are in AUD, before tax.')).toBeTruthy();
  });

  it('says prices include tax once the Market answered', async () => {
    mount();
    expect(screen.getByText('Prices are in AUD.')).toBeTruthy();
    await flush();
    expect(screen.getByText('Prices are in AUD and include tax.')).toBeTruthy();
  });

  it('waits for publication when the product has no published tax category', async () => {
    vi.mocked(callApi).mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'pricing.estimate-no-tax-category' },
    } as never);
    mount();
    await flush();
    expect(cellOf('250 g').textContent).toBe('\u2014');
    expect(screen.getByText(/shows once the product is published/)).toBeTruthy();
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

    // The typed price is named once, in "What you receive".
    expect(screen.queryByText('Typed, not saved yet')).toBeNull();

    open('1 kg');
    expect(
      within(screen.getByRole('region', { name: 'What you receive' })).getByText(
        'Set a price to see what you receive.',
      ),
    ).toBeTruthy();
  });

  it('asks for a full price while the typed text is not an amount', async () => {
    mount();
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Price for 250 g' }), {
      target: { value: '18.' },
    });
    open('250 g');
    expect(screen.getByText('Type a full price to see what you receive.')).toBeTruthy();
  });

  it('shows nothing to receive for a size no longer sold', async () => {
    mount({ rows: [row(V1, '250 g', '950', { retired: true })] });
    await flush();
    open('250 g');
    expect(screen.queryByRole('region', { name: 'What you receive' })).toBeNull();
  });
});
