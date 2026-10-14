// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { feeProblemOf } from './errors.ts';
import { FlatFeeCard } from './flat-fee-card.tsx';
import { formatMinor, inputOf, minorOf } from './money.ts';
import type { FlatFee } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const fee = (amount: string | null, currency = 'AUD'): FlatFee => ({
  sellerId: SELLER,
  amount,
  currency,
});
const mount = (initial: FlatFee, canManage = true) =>
  render(wrap(<FlatFeeCard initial={initial} canManage={canManage} csrfToken="csrf" />));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('FlatFeeCard', () => {
  it('says checkout is closed while no fee is set', () => {
    mount(fee(null));
    expect(screen.getByText(/Customers cannot check out with this seller/)).toBeTruthy();
  });

  it('shows the current fee, and no form without the manage permission', () => {
    mount(fee('995'), false);
    expect(screen.getByText('$9.95')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('sets the fee in minor units, zero included, and shows the answer', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: fee('995') });
    mount(fee(null));
    fireEvent.change(screen.getByLabelText(/Fee per order/), { target: { value: '9.95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save fee' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `shipping/admin/sellers/${SELLER}/flat-fee`,
      { amount: 995 },
      'csrf',
    );
    expect(await screen.findByText(/Fee saved/)).toBeTruthy();
    expect(screen.getByText('$9.95')).toBeTruthy();

    call.mockResolvedValue({ ok: true, status: 200, body: fee('0') });
    fireEvent.change(screen.getByLabelText(/Fee per order/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save fee' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toEqual({ amount: 0 });
  });

  it('refuses a bad amount before calling the API', () => {
    mount(fee('995'));
    for (const bad of ['', 'abc', '-1', '9.999', '1001']) {
      fireEvent.change(screen.getByLabelText(/Fee per order/), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Save fee' }));
      expect(screen.getByText(/Enter an amount between 0 and \$1,000\.00/)).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount(fee('995'));
    fireEvent.click(screen.getByRole('button', { name: 'Save fee' }));
    expect(await screen.findByText('Your role cannot set delivery fees.')).toBeTruthy();
  });
});

describe('money helpers', () => {
  it('parse exactly, per currency exponent', () => {
    expect(minorOf('9.95', 'AUD')).toBe(995);
    expect(minorOf('0', 'AUD')).toBe(0);
    expect(minorOf('10', 'AUD')).toBe(1000);
    expect(minorOf('9.955', 'AUD')).toBeNull();
    expect(minorOf('500', 'JPY')).toBe(500);
    expect(minorOf('5.0', 'JPY')).toBeNull();
    expect(inputOf('995', 'AUD')).toBe('9.95');
    expect(inputOf('5', 'AUD')).toBe('0.05');
    expect(inputOf('500', 'JPY')).toBe('500');
    expect(formatMinor('995', 'AUD')).toBe('$9.95');
  });

  it('name a failed write', () => {
    expect(feeProblemOf({ status: 404, code: 'shipping.seller-not-found' })).toBe('not-found');
    expect(feeProblemOf({ status: 503, code: 'shipping.unavailable' })).toBe('unavailable');
    expect(feeProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
