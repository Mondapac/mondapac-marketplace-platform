// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { priceProblemOf } from './errors.ts';
import { formatMinor, inputOf, minorOf } from './money.ts';
import { OfferPrices } from './offer-prices.tsx';
import { formatInZone, instantOfZoned } from './zone-time.ts';
import type { OfferPricesView } from './types.ts';

const call = vi.mocked(callApi);
const view: OfferPricesView = {
  offerId: 'o1',
  currency: 'AUD',
  variants: [
    {
      variantId: 'v1',
      seriesVersion: 3,
      currency: 'AUD',
      inForce: { amount: '1999', effectiveFrom: '2026-10-01T00:00:00Z' },
      held: { amount: '2999', submittedAt: '2026-10-02T00:00:00Z', direction: 'up' },
      special: {
        amount: '1499',
        startsAt: '2026-10-05T00:00:00Z',
        endsAt: '2026-10-30T00:00:00Z',
        state: 'running',
      },
      heldSpecial: null,
      retired: false,
    },
    {
      variantId: 'v2',
      seriesVersion: null,
      currency: null,
      inForce: null,
      held: null,
      special: null,
      heldSpecial: null,
      retired: false,
    },
  ],
};
const mount = (canEdit = true, v: OfferPricesView = view, zone?: string) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OfferPrices offerId="o1" view={v} canEdit={canEdit} csrfToken="csrf" zone={zone} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign: vi.fn() }, writable: true });
});
afterEach(cleanup);

describe('money', () => {
  it('reads and shows minor units exactly', () => {
    expect(minorOf('19.99', 'AUD')).toBe('1999');
    expect(minorOf('20', 'AUD')).toBe('2000');
    expect(minorOf('20.5', 'AUD')).toBe('2050');
    expect(minorOf('0.05', 'AUD')).toBe('5');
    expect(minorOf('1000', 'JPY')).toBe('1000');
    expect(inputOf('1999', 'AUD')).toBe('19.99');
    expect(inputOf('5', 'AUD')).toBe('0.05');
    expect(inputOf('1000', 'JPY')).toBe('1000');
    expect(formatMinor('1999', 'AUD')).toBe('$19.99');
  });
  it('refuses zero, too many decimals, signs and text', () => {
    for (const text of ['', '0', '0.00', '1.999', '-5', '1e3', 'abc', '12.']) {
      expect(minorOf(text, 'AUD')).toBeNull();
    }
    expect(minorOf('10.5', 'JPY')).toBeNull();
  });
});

describe('OfferPrices', () => {
  it('shows the price in force and the held change', () => {
    mount();
    expect(screen.getByText(/Current price \$19\.99/)).toBeTruthy();
    expect(screen.getByText(/A raise to \$29\.99/)).toBeTruthy();
    expect(screen.getByText('No price set yet.')).toBeTruthy();
  });

  it('saves with the version it read and says when a change is held', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'pending-review', seriesVersion: 4, recordId: 'r1', effectiveFrom: null },
    });
    mount();
    const [first] = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '45.50' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save price' })[0] as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/regular-price',
      { amount: '4550', currency: 'AUD', expectedVersion: 3 },
      'csrf',
    );
    expect(
      await screen.findByText('Saved. The change is large, so it waits for review.'),
    ).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('sends a null version for a first price', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'accepted', seriesVersion: 1, recordId: 'r1', effectiveFrom: 'x' },
    });
    mount();
    const fields = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(fields[1] as HTMLElement, { target: { value: '5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save price' })[1] as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[3]).toBe('csrf');
    expect(call.mock.calls[0]?.[2]).toEqual({
      amount: '500',
      currency: 'AUD',
      expectedVersion: null,
    });
  });

  it('refuses a bad amount without calling the API', () => {
    mount();
    const [first] = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '1.999' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save price' })[0] as HTMLElement);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a price above zero/)).toBeTruthy();
  });

  it('reloads on a stale answer and shows no form without edit permission', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'conflict.stale' },
    } as never);
    mount();
    const [first] = screen.getAllByLabelText('Price (AUD, GST included)');
    fireEvent.change(first as HTMLElement, { target: { value: '30' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save price' })[0] as HTMLElement);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText(/The price changed somewhere else/)).toBeTruthy();
    cleanup();
    mount(false);
    expect(screen.queryByRole('button', { name: 'Save price' })).toBeNull();
  });

  it('maps API codes to message keys', () => {
    expect(priceProblemOf({ status: 409, code: 'pricing.series-retired' })).toBe('retired');
    expect(priceProblemOf({ status: 503, code: 'access.unavailable' })).toBe('unavailable');
    expect(priceProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });

  it('shows the running special and no special form for an unpriced variant', () => {
    mount();
    expect(screen.getByText(/Special price \$14\.99 is running/)).toBeTruthy();
    expect(screen.getAllByText('Special price')).toHaveLength(1);
  });

  it('sets a special with the shared version, typed in the seller zone, and the regular form follows the new version', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'pending-review', seriesVersion: 4 },
    });
    mount(true, view, 'Australia/Sydney');
    fireEvent.change(screen.getByLabelText('Special price (AUD, GST included)'), {
      target: { value: '9.50' },
    });
    fireEvent.change(screen.getByLabelText('Ends (Australia/Sydney)'), {
      target: { value: '2026-11-01T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save special price' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'pricing/seller/offers/o1/variants/v1/special-price',
      {
        amount: '950',
        currency: 'AUD',
        startsAt: null,
        endsAt: '2026-10-31T23:30:00Z',
        expectedVersion: 3,
      },
      'csrf',
    );
    expect(await screen.findByText(/The discount is large/)).toBeTruthy();
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: 'accepted', seriesVersion: 5, recordId: 'r', effectiveFrom: 'x' },
    });
    fireEvent.change(screen.getAllByLabelText('Price (AUD, GST included)')[0] as HTMLElement, {
      target: { value: '30' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save price' })[0] as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toMatchObject({ expectedVersion: 4 });
  });

  it('reads datetime-local text as a wall-clock time in a zone', () => {
    expect(instantOfZoned('2026-11-01T10:30', 'UTC')).toBe('2026-11-01T10:30:00Z');
    expect(instantOfZoned('2026-11-01T10:30', 'Australia/Sydney')).toBe('2026-10-31T23:30:00Z');
    expect(instantOfZoned('2026-06-01T10:30', 'Australia/Sydney')).toBe('2026-06-01T00:30:00Z');
    expect(instantOfZoned('2026-06-01T10:30', 'Australia/Perth')).toBe('2026-06-01T02:30:00Z');
    expect(instantOfZoned('', 'UTC')).toBeNull();
    expect(instantOfZoned('nonsense', 'UTC')).toBeNull();
    expect(instantOfZoned('2026-11-01T10:30', 'Not/AZone')).toBeNull();
  });

  it('handles the clock changes of a zone', () => {
    // Sydney: clocks go forward 2026-10-04 02:00 -> 03:00 and back 2027-04-04 03:00 -> 02:00.
    expect(instantOfZoned('2026-10-04T02:30', 'Australia/Sydney')).toBeNull();
    expect(instantOfZoned('2026-10-04T03:30', 'Australia/Sydney')).toBe('2026-10-03T16:30:00Z');
    expect(instantOfZoned('2027-04-04T02:30', 'Australia/Sydney')).toBe('2027-04-03T15:30:00Z');
  });

  it('shows instants in the zone with its id', () => {
    expect(formatInZone('2026-10-31T23:30:00Z', 'Australia/Sydney')).toMatch(
      /1 Nov 2026.*10:30.*Australia\/Sydney$/,
    );
    expect(formatInZone(null, 'UTC')).toBe('-');
  });

  it('falls back to UTC labels when the zone could not be read', () => {
    mount();
    expect(screen.getByLabelText('Ends (UTC)')).toBeTruthy();
  });

  it('ends the special now with the version and shows API refusals', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { seriesVersion: 4, endedRecordId: 'r', cancelledRecordId: null },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'End special now' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'pricing/seller/offers/o1/variants/v1/special-price/withdraw',
      { expectedVersion: 3 },
      'csrf',
    );
    expect(await screen.findByText('The special price was ended.')).toBeTruthy();
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, code: 'pricing.special-not-below-regular' },
    } as never);
    fireEvent.change(screen.getByLabelText('Special price (AUD, GST included)'), {
      target: { value: '99' },
    });
    fireEvent.change(screen.getByLabelText('Ends (UTC)'), {
      target: { value: '2026-11-01T10:30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save special price' }));
    expect(await screen.findByText(/must be below the regular price/)).toBeTruthy();
  });

  it('shows a held special and hides the special form without edit permission', () => {
    const held: OfferPricesView = {
      ...view,
      variants: [
        {
          ...(view.variants[0] as OfferPricesView['variants'][number]),
          special: null,
          heldSpecial: {
            amount: '500',
            startsAt: '2026-10-05T00:00:00Z',
            endsAt: '2026-10-30T00:00:00Z',
            submittedAt: '2026-10-04T00:00:00Z',
          },
        },
      ],
    };
    mount(false, held);
    expect(screen.getByText(/special price of \$5\.00/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save special price' })).toBeNull();
    expect(priceProblemOf({ status: 409, code: 'pricing.regular-not-above-special' })).toBe(
      'regular-not-above',
    );
  });
});
