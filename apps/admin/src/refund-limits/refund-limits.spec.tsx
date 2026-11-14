// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, Toaster } from '@mondapac/ui';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { refundLimitProblemOf } from './errors.ts';
import { bodyOf, formOf } from './form.ts';
import { RefundLimitsPanel } from './market-panel.tsx';
import { RefundLimitCard } from './seller-card.tsx';
import type { RefundLimit, RefundLimits } from './types.ts';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-000000000001';
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
    <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
  </NextIntlClientProvider>
);
const limit = (patch: Partial<RefundLimit> = {}, currency = 'AUD'): RefundLimit => ({
  maxCount: 5,
  maxAmount: { amount: '50000', currency },
  version: 2,
  updatedAt: '2026-11-10T01:00:00Z',
  updatedBy: '0190a000-0000-7000-8000-0000000000aa',
  ...patch,
});
const limits = (patch: Partial<RefundLimits> = {}): RefundLimits => ({
  currency: 'AUD',
  marketDefault: null,
  own: null,
  inForce: 'none',
  ...patch,
});
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({ ok: false as const, failure: { status, code } });
const panel = (initial: RefundLimits, canManage = true) =>
  render(
    wrap(<RefundLimitsPanel initial={initial} canManage={canManage} csrfToken="csrf" zone="UTC" />),
  );
const card = (initial: RefundLimits, canManage = true) =>
  render(
    wrap(
      <RefundLimitCard
        sellerId={SELLER}
        initial={initial}
        canManage={canManage}
        csrfToken="csrf"
        zone="UTC"
      />,
    ),
  );

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  toast.dismiss();
});

describe('form helpers', () => {
  it('sends the amount as a minor-unit string, by the currency decimals', () => {
    expect(bodyOf({ count: '5', amount: '500.5' }, 'AUD')).toEqual({
      ok: true,
      body: { maxCount: 5, maxAmount: '50050' },
    });
    expect(bodyOf({ count: '5', amount: '500' }, 'JPY')).toEqual({
      ok: true,
      body: { maxCount: 5, maxAmount: '500' },
    });
    expect(bodyOf({ count: '5', amount: '1.234' }, 'KWD')).toMatchObject({
      body: { maxAmount: '1234' },
    });
  });

  it('refuses a count outside 1 to 1000 and an amount that is empty, zero or too precise', () => {
    expect(bodyOf({ count: '0', amount: '1' }, 'AUD')).toEqual({
      ok: false,
      errors: { count: 'count' },
    });
    expect(bodyOf({ count: '1001', amount: '1' }, 'AUD')).toMatchObject({ ok: false });
    expect(bodyOf({ count: '1.5', amount: '1' }, 'AUD')).toMatchObject({ ok: false });
    expect(bodyOf({ count: '1', amount: '' }, 'AUD')).toEqual({
      ok: false,
      errors: { amount: 'amount-required' },
    });
    expect(bodyOf({ count: '1', amount: '0' }, 'AUD')).toMatchObject({
      errors: { amount: 'amount' },
    });
    expect(bodyOf({ count: '1', amount: '1.234' }, 'AUD')).toMatchObject({
      errors: { amount: 'amount' },
    });
    expect(bodyOf({ count: '1', amount: '1' }, 'ZZ')).toMatchObject({
      errors: { amount: 'currency' },
    });
  });

  it('starts the form from the cap in major units', () => {
    expect(formOf(limit(), 'AUD')).toEqual({ count: '5', amount: '500.00' });
    expect(formOf(null, 'AUD')).toEqual({ count: '', amount: '' });
  });

  it('names the message for each failure', () => {
    expect(refundLimitProblemOf({ status: 409, code: 'conflict.retry' })).toBe('stale');
    expect(refundLimitProblemOf({ status: 404, code: 'ordering.refund-limit-not-found' })).toBe(
      'not-found',
    );
    expect(refundLimitProblemOf({ status: 400, code: 'validation.failed' })).toBe('invalid');
    expect(refundLimitProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
  });
});

describe('Market default panel', () => {
  it('shows the fail-closed empty state and a set button when no default exists', () => {
    panel(limits());
    expect(
      screen.getByText(
        'No default is set. Sellers cannot refund by marking items unavailable until a cap is set.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set default cap' })).toBeTruthy();
  });

  it('shows the default in the Market currency with its version', () => {
    panel(limits({ marketDefault: limit(), inForce: 'market' }));
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('$500.00')).toBeTruthy();
    expect(screen.getByText('Version 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit default cap' })).toBeTruthy();
  });

  it('formats money in a currency other than AUD from the API', () => {
    panel(
      limits({
        currency: 'JPY',
        marketDefault: limit({ maxAmount: { amount: '50000', currency: 'JPY' } }),
        inForce: 'market',
      }),
    );
    expect(screen.queryByText('$500.00')).toBeNull();
    expect(screen.getByText(/50,000/)).toBeTruthy();
  });

  it('is read-only without the manage key: no button, and the empty state still shows', () => {
    panel(limits(), false);
    expect(screen.queryByRole('button', { name: 'Set default cap' })).toBeNull();
    expect(
      screen.getAllByText(/cannot refund by marking items unavailable/).length,
    ).toBeGreaterThan(0);
    cleanup();
    panel(limits({ marketDefault: limit(), inForce: 'market' }), false);
    expect(screen.queryByRole('button', { name: 'Edit default cap' })).toBeNull();
  });

  it('validates before sending, then saves minor units with the version seen', async () => {
    panel(limits({ marketDefault: limit(), inForce: 'market' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit default cap' }));
    fireEvent.change(screen.getByLabelText('Most refunds in 24 hours'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a whole number from 1 to 1000.')).toBeTruthy();

    call.mockResolvedValueOnce(
      ok(limits({ marketDefault: limit({ maxCount: 8, version: 3 }), inForce: 'market' })),
    );
    fireEvent.change(screen.getByLabelText('Most refunds in 24 hours'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Version 3')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'ordering/admin/refund-limits',
      { maxCount: 8, maxAmount: '50000', expectedVersion: 2 },
      'csrf',
    );
  });

  it('on a stale 409 shows the message, reads the latest and sends its version next', async () => {
    panel(limits({ marketDefault: limit(), inForce: 'market' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit default cap' }));
    call.mockResolvedValueOnce(fail(409, 'conflict.retry'));
    call.mockResolvedValueOnce(
      ok(limits({ marketDefault: limit({ maxCount: 9, version: 3 }), inForce: 'market' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByText(/Another admin changed this cap first/)).toBeTruthy(),
    );
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'ordering/admin/refund-limits');
    call.mockResolvedValueOnce(
      ok(limits({ marketDefault: limit({ version: 4 }), inForce: 'market' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]?.[2]).toMatchObject({ expectedVersion: 3 });
  });
});

describe('Market default first save', () => {
  it('sends expectedVersion 0 when no default exists yet', async () => {
    panel(limits());
    fireEvent.click(screen.getByRole('button', { name: 'Set default cap' }));
    fireEvent.change(screen.getByLabelText('Most refunds in 24 hours'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/Most refunded in 24 hours \(AUD\)/), {
      target: { value: '100' },
    });
    call.mockResolvedValueOnce(
      ok(limits({ marketDefault: limit({ maxCount: 4, version: 1 }), inForce: 'market' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Version 1')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'ordering/admin/refund-limits',
      { maxCount: 4, maxAmount: '10000', expectedVersion: 0 },
      'csrf',
    );
  });
});

describe('seller card', () => {
  it('shows the seller own cap, with the Market default noted', () => {
    card(limits({ own: limit({ maxCount: 2 }), marketDefault: limit(), inForce: 'own' }));
    expect(screen.getByText("Seller's own cap")).toBeTruthy();
    expect(screen.getByText(/Market default: 5 refunds/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit own cap' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove own cap' })).toBeTruthy();
  });

  it('shows the Market default in force with a set button only', () => {
    card(limits({ marketDefault: limit(), inForce: 'market' }));
    expect(screen.getAllByText('Market default').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Set own cap' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove own cap' })).toBeNull();
  });

  it('says no cap is set and that the seller cannot refund', () => {
    card(limits());
    expect(screen.getByText('No cap set')).toBeTruthy();
    expect(screen.getByText(/this seller cannot refund by marking items unavailable/)).toBeTruthy();
  });

  it('is read-only for the view key', () => {
    card(limits({ own: limit(), inForce: 'own' }), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/You can see this cap but not change it/)).toBeTruthy();
  });

  it('sets the own cap for the seller, from version 0', async () => {
    card(limits({ marketDefault: limit(), inForce: 'market' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set own cap' }));
    fireEvent.change(screen.getByLabelText('Most refunds in 24 hours'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/Most refunded in 24 hours \(AUD\)/), {
      target: { value: '120' },
    });
    call.mockResolvedValueOnce(
      ok(
        limits({ own: limit({ maxCount: 3, version: 1 }), marketDefault: limit(), inForce: 'own' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText("The seller's own cap is saved.")).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `ordering/admin/refund-limits/sellers/${SELLER}`,
      { maxCount: 3, maxAmount: '12000', expectedVersion: 0 },
      'csrf',
    );
  });

  it('removes the own cap with the version seen and falls back to the default', async () => {
    card(limits({ own: limit({ version: 4 }), marketDefault: limit(), inForce: 'own' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove own cap' }));
    call.mockResolvedValueOnce(ok(limits({ marketDefault: limit(), inForce: 'market' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove own cap' }).at(-1)!);
    await waitFor(() => expect(screen.getByText("The seller's own cap is removed.")).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      `ordering/admin/refund-limits/sellers/${SELLER}?expectedVersion=4`,
      undefined,
      'csrf',
    );
    expect(screen.getByRole('button', { name: 'Set own cap' })).toBeTruthy();
  });

  it('on a stale remove shows the message and reads the latest', async () => {
    card(limits({ own: limit(), marketDefault: limit(), inForce: 'own' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove own cap' }));
    call.mockResolvedValueOnce(fail(409, 'conflict.retry'));
    call.mockResolvedValueOnce(
      ok(limits({ own: limit({ version: 3 }), marketDefault: limit(), inForce: 'own' })),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove own cap' }).at(-1)!);
    await waitFor(() =>
      expect(screen.getAllByText(/Another admin changed this cap first/).length).toBeGreaterThan(0),
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      'GET',
      `ordering/admin/refund-limits?sellerId=${SELLER}`,
    );
  });

  it('on a remove that finds no own cap shows the message and reads the latest', async () => {
    card(limits({ own: limit(), marketDefault: limit(), inForce: 'own' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove own cap' }));
    call.mockResolvedValueOnce(fail(404, 'ordering.refund-limit-not-found'));
    call.mockResolvedValueOnce(ok(limits({ marketDefault: limit(), inForce: 'market' })));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove own cap' }).at(-1)!);
    await waitFor(() =>
      expect(
        screen.getAllByText(/This seller has no cap of its own any more/).length,
      ).toBeGreaterThan(0),
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      'GET',
      `ordering/admin/refund-limits?sellerId=${SELLER}`,
    );
  });

  it('edits the own cap with the version seen', async () => {
    card(limits({ own: limit({ version: 4 }), marketDefault: limit(), inForce: 'own' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit own cap' }));
    fireEvent.change(screen.getByLabelText('Most refunds in 24 hours'), { target: { value: '7' } });
    call.mockResolvedValueOnce(
      ok(
        limits({ own: limit({ maxCount: 7, version: 5 }), marketDefault: limit(), inForce: 'own' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText("The seller's own cap is saved.")).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `ordering/admin/refund-limits/sellers/${SELLER}`,
      { maxCount: 7, maxAmount: '50000', expectedVersion: 4 },
      'csrf',
    );
  });

  it.each([
    ['set', limits({ marketDefault: limit(), inForce: 'market' }), 'Set own cap', 0],
    [
      'edit',
      limits({ own: limit({ version: 4 }), marketDefault: limit(), inForce: 'own' }),
      'Edit own cap',
      4,
    ],
  ] as const)(
    'on a stale 409 on %s shows the message and reads the latest',
    async (_n, start, open, version) => {
      card(start);
      fireEvent.click(screen.getByRole('button', { name: open }));
      fireEvent.change(screen.getByLabelText('Most refunds in 24 hours'), {
        target: { value: '3' },
      });
      fireEvent.change(screen.getByLabelText(/Most refunded in 24 hours \(AUD\)/), {
        target: { value: '10' },
      });
      call.mockResolvedValueOnce(fail(409, 'conflict.retry'));
      call.mockResolvedValueOnce(
        ok(limits({ own: limit({ version: 9 }), marketDefault: limit(), inForce: 'own' })),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(screen.getByText(/Another admin changed this cap first/)).toBeTruthy(),
      );
      expect(call.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: version });
      expect(call).toHaveBeenNthCalledWith(
        2,
        'GET',
        `ordering/admin/refund-limits?sellerId=${SELLER}`,
      );
    },
  );
});
