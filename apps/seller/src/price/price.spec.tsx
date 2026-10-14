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
      retired: false,
    },
    {
      variantId: 'v2',
      seriesVersion: null,
      currency: null,
      inForce: null,
      held: null,
      retired: false,
    },
  ],
};
const mount = (canEdit = true, v: OfferPricesView = view) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OfferPrices offerId="o1" view={v} canEdit={canEdit} csrfToken="csrf" />
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
});
