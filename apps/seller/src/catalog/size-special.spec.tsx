// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

// The special price in a size's Details (Offer page PR 6): typed as drafts of the table, saved
// with "Save N changes" after the regular price, and ended with its own button.

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
const source: SourceView = {
  id: 's1',
  name: 'Warehouse',
  isDefault: false,
  position: 0,
  address: null,
  timeZone: null,
  createdAt: '2026-10-01T00:00:00Z',
};
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
const row = (id: string, label: string, amount: string | null, over = {}): TableRow => ({
  variantId: id,
  label,
  price: price(id, amount, over),
  stock: { s1: { variantId: id, sourceId: 's1', onHand: 5, held: 0, version: 5, retired: false } },
});
const RUNNING = {
  special: {
    amount: '1590',
    startsAt: '2026-11-20T00:00:00Z',
    endsAt: '2026-11-30T07:00:00Z',
    state: 'running' as const,
  },
};
const ROWS = [
  row('v1', '250 g', '950'),
  row('v2', '500 g', '1790', RUNNING),
  row('v3', '1 kg', null),
];

function mount(over: Partial<Parameters<typeof VariantsTable>[0]> = {}) {
  // Brisbane has no daylight saving: 10:00 there is 00:00 UTC all year.
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
      <VariantsTable
        offerId="o1"
        rows={ROWS}
        sources={[source]}
        currency="AUD"
        canEditPrice
        canEditStock
        csrfToken="csrf"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}
const details = (size: string) =>
  fireEvent.click(screen.getAllByRole('button', { name: `Details for ${size}` })[0]!);
const panel = (size: string) => within(screen.getByRole('group', { name: size }));
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('special price in Details', () => {
  it('saves a new special with Save, in the seller zone, and counts it as one change', async () => {
    call.mockResolvedValue(ok({ status: 'accepted', seriesVersion: 4 }));
    mount();
    details('250 g');
    const open = panel('250 g');
    expect(open.getByText('No special price.')).toBeTruthy();
    fireEvent.change(open.getByLabelText('Special price (AUD) for 250 g'), {
      target: { value: '8.50' },
    });
    fireEvent.change(open.getByLabelText('Special ends, 250 g'), {
      target: { value: '2026-12-01T10:00' },
    });
    // The draft stays, and the row says so, when its Details closes.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close details for 250 g' })[0]!);
    expect(screen.getByText('Special not saved')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/special-price',
      {
        amount: '850',
        currency: 'AUD',
        startsAt: null,
        endsAt: '2026-12-01T00:00:00Z',
        expectedVersion: 3,
      },
      'csrf',
    );
    await expectToast('Saved 1 change.');
    expect(refresh).toHaveBeenCalled();
  });

  it('sends the regular price first, then the special with the version it moved', async () => {
    call
      .mockResolvedValueOnce(
        ok({ status: 'accepted', seriesVersion: 4, recordId: 'r', effectiveFrom: null }),
      )
      .mockResolvedValueOnce(ok({ status: 'pending-review', seriesVersion: 5 }));
    mount();
    fireEvent.change(screen.getByLabelText('Price for 250 g'), { target: { value: '12.00' } });
    details('250 g');
    const open = panel('250 g');
    fireEvent.change(open.getByLabelText('Special price (AUD) for 250 g'), {
      target: { value: '6' },
    });
    fireEvent.change(open.getByLabelText('Special starts, 250 g'), {
      target: { value: '2026-12-01T10:00' },
    });
    fireEvent.change(open.getByLabelText('Special ends, 250 g'), {
      target: { value: '2026-12-08T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[0]?.[1]).toBe('pricing/seller/offers/o1/variants/v1/regular-price');
    expect(call.mock.calls[1]?.[1]).toBe('pricing/seller/offers/o1/variants/v1/special-price');
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      amount: '600',
      startsAt: '2026-12-01T00:00:00Z',
      endsAt: '2026-12-08T00:00:00Z',
      expectedVersion: 4,
    });
    await expectToast(/waits for review/, 'info');
  });

  it('sends nothing for a special without an end, and opens its size on the message', async () => {
    mount();
    details('250 g');
    fireEvent.change(panel('250 g').getByLabelText('Special price (AUD) for 250 g'), {
      target: { value: '8.50' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Close details for 250 g' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    const open = panel('250 g');
    expect(open.getByText('Enter the end date and time.')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(open.getByLabelText('Special ends, 250 g')),
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a refusal under the field it is about and keeps the draft', async () => {
    call.mockResolvedValue({
      ok: false,
      status: 422,
      failure: { status: 422, code: 'pricing.special-not-below-regular', message: 'x' },
    } as never);
    mount();
    details('250 g');
    const open = panel('250 g');
    fireEvent.change(open.getByLabelText('Special price (AUD) for 250 g'), {
      target: { value: '9.50' },
    });
    fireEvent.change(open.getByLabelText('Special ends, 250 g'), {
      target: { value: '2026-12-01T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(await open.findByText('A special price must be below the regular price.')).toBeTruthy();
    expect(open.getByLabelText<HTMLInputElement>('Special price (AUD) for 250 g').value).toBe(
      '9.50',
    );
  });

  it('ends a running special at once with its own button', async () => {
    call.mockResolvedValue(ok({ seriesVersion: 4, endedRecordId: 'r', cancelledRecordId: null }));
    mount();
    details('500 g');
    fireEvent.click(panel('500 g').getByRole('button', { name: 'End special price of 500 g' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'pricing/seller/offers/o1/variants/v2/special-price/withdraw',
        { expectedVersion: 3 },
        'csrf',
      ),
    );
    await expectToast('The special price was ended.');
    expect(refresh).toHaveBeenCalled();
  });

  it('asks for a regular price first when the size has none', () => {
    mount();
    details('1 kg');
    const open = panel('1 kg');
    expect(open.getByText(/Set a regular price first/)).toBeTruthy();
    expect(open.queryByLabelText('Special price (AUD) for 1 kg')).toBeNull();
  });

  it('shows the special without fields or buttons to a seller who may not change prices', () => {
    mount({ canEditPrice: false });
    details('500 g');
    const open = panel('500 g');
    expect(open.getByText(/\$15\.90 until 30 Nov 2026/)).toBeTruthy();
    expect(open.queryByRole('button', { name: /End special/ })).toBeNull();
    expect(open.queryByLabelText(/Special price \(AUD\)/)).toBeNull();
  });

  const fail = (code: string, status = 422) =>
    ({ ok: false, status, failure: { status, code, message: 'x' } }) as never;
  const typeSpecial = (size: string, amount: string, end: string, start = '') => {
    const open = panel(size);
    fireEvent.change(open.getByLabelText(`Special price (AUD) for ${size}`), {
      target: { value: amount },
    });
    if (start !== '')
      fireEvent.change(open.getByLabelText(`Special starts, ${size}`), {
        target: { value: start },
      });
    fireEvent.change(open.getByLabelText(`Special ends, ${size}`), { target: { value: end } });
  };

  it.each([
    [
      'pricing.special-window.start-in-past',
      'Special starts, 250 g',
      "The start can't be in the past.",
    ],
    ['pricing.special-window.invalid', 'Special ends, 250 g', 'The end must be after the start.'],
  ])('puts the refusal %s under the field it is about', async (code, field, message) => {
    call.mockResolvedValue(fail(code));
    mount();
    details('250 g');
    typeSpecial('250 g', '8.50', '2026-12-08T10:00', '2099-12-01T10:00');
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    await panel('250 g').findByText(message);
    const input = panel('250 g').getByLabelText(field);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the special unsent when the regular price of its size is refused in the same save', async () => {
    call.mockResolvedValue(fail('pricing.amount-out-of-range'));
    mount();
    fireEvent.change(screen.getByLabelText('Price for 250 g'), { target: { value: '12.00' } });
    details('250 g');
    typeSpecial('250 g', '8.50', '2026-12-08T10:00');
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    expect(await screen.findByText('This price is outside the allowed range.')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[1]).toBe('pricing/seller/offers/o1/variants/v1/regular-price');
    expect(
      panel('250 g').getByLabelText<HTMLInputElement>('Special price (AUD) for 250 g').value,
    ).toBe('8.50');
  });

  it('sends the special first when the new regular price is not above the running one', async () => {
    call
      .mockResolvedValueOnce(ok({ status: 'pending-review', seriesVersion: 4 }))
      .mockResolvedValueOnce(fail('pricing.regular-not-above-special'));
    mount();
    fireEvent.change(screen.getByLabelText('Price for 500 g'), { target: { value: '15.00' } });
    details('500 g');
    fireEvent.click(panel('500 g').getByRole('button', { name: 'Replace special price' }));
    typeSpecial('500 g', '12.00', '2026-12-08T10:00');
    fireEvent.click(screen.getByRole('button', { name: 'Save 2 changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[0]?.[1]).toBe('pricing/seller/offers/o1/variants/v2/special-price');
    expect(call.mock.calls[1]?.[2]).toMatchObject({ amount: '1500', expectedVersion: 4 });
    // The held special leaves the running one in force, so the lower regular price is refused.
    expect(
      await screen.findByText(/The regular price must stay above the special price/),
    ).toBeTruthy();
  });

  it('shows why End was refused and reloads on a stale version', async () => {
    call.mockResolvedValue(fail('conflict.stale', 409));
    mount();
    details('500 g');
    fireEvent.click(panel('500 g').getByRole('button', { name: 'End special price of 500 g' }));
    expect(await panel('500 g').findByText(/The price changed somewhere else/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('does not save while an End is still running', async () => {
    let finish: (value: unknown) => void = () => {};
    call.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)) as never);
    mount();
    details('500 g');
    fireEvent.change(screen.getByLabelText('Price for 250 g'), { target: { value: '9.90' } });
    fireEvent.click(panel('500 g').getByRole('button', { name: 'End special price of 500 g' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(call).toHaveBeenCalledTimes(1);
    finish(ok({ seriesVersion: 4, endedRecordId: 'r', cancelledRecordId: null }));
    await expectToast('The special price was ended.');
  });
});
