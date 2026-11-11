// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { taxProblemOf } from './errors.ts';
import { TaxPanel } from './tax-panel.tsx';
import { parsePercent, percentOf, type TaxStrategy, type TaxStrategyList } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const strategy = (patch: Partial<TaxStrategy> = {}): TaxStrategy => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'GST 10',
  kind: 'flat-rate',
  rateBps: 1000,
  defaultRateBps: null,
  categoryRatesBps: null,
  active: false,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...patch,
});
const data = (patch: Partial<TaxStrategyList> = {}): TaxStrategyList => ({
  builtInRateBps: 1000,
  activeStrategyId: null,
  categoryCodes: ['taxable', 'gst_free'],
  strategies: [strategy()],
  ...patch,
});
const mount = (initial: TaxStrategyList, canManage = true) =>
  render(wrap(<TaxPanel initial={initial} canManage={canManage} csrfToken="csrf" />));
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

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
afterEach(cleanup);

describe('percent helpers', () => {
  it('parses 0 to 50 with up to two decimals into basis points', () => {
    expect(parsePercent('10')).toBe(1000);
    expect(parsePercent('7,5')).toBe(750);
    expect(parsePercent('0.25')).toBe(25);
    expect(parsePercent('50')).toBe(5000);
    expect(parsePercent('50.01')).toBeNull();
    expect(parsePercent('1.234')).toBeNull();
    expect(parsePercent('-1')).toBeNull();
    expect(parsePercent('')).toBeNull();
    expect(parsePercent('abc')).toBeNull();
  });
  it('shows basis points as a percentage', () => {
    expect(percentOf(1000)).toBe('10 %');
    expect(percentOf(750)).toBe('7.5 %');
  });
  it('maps failures to message keys', () => {
    expect(taxProblemOf({ status: 409, code: 'tax.strategy-active' })).toBe('active');
    expect(taxProblemOf({ status: 403, code: 'x' })).toBe('denied');
    expect(taxProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(taxProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});

describe('TaxPanel', () => {
  it('shows the built-in rate when no strategy is in force, and the strategies', () => {
    mount(data());
    expect(screen.getByText(/Built-in rate · 10 %/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to built-in rate' })).toBeNull();
    const row = screen.getByRole('row', { name: /GST 10/ });
    expect(within(row).getByText('Not active')).toBeTruthy();
  });

  it('shows the empty state without strategies', () => {
    mount(data({ strategies: [] }));
    expect(screen.getByText('No tax strategies yet')).toBeTruthy();
  });

  it('hides every action without the manage key', () => {
    mount(data(), false);
    expect(screen.queryByRole('button', { name: 'Add strategy' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByText(/You can see the tax strategies/)).toBeTruthy();
  });

  it('hides Activate and Delete on the strategy in force', () => {
    const active = strategy({ active: true });
    mount(data({ activeStrategyId: active.id, strategies: [active] }));
    expect(screen.getByRole('button', { name: 'Edit GST 10' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activate GST 10' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete GST 10' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to built-in rate' })).toBeTruthy();
  });

  it('adds a flat-rate strategy as basis points and reads the list again', async () => {
    call.mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(data({ strategies: [] })));
    mount(data({ strategies: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Add strategy' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Reduced ' } });
    fireEvent.change(screen.getByLabelText('Rate (%)'), { target: { value: '7,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'tax/admin/strategies',
        { name: 'Reduced', kind: 'flat-rate', rateBps: 750 },
        'csrf',
      ),
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'tax/admin/strategies'));
  });

  it('refuses a bad rate on the screen and sends nothing', () => {
    mount(data({ strategies: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Add strategy' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Rate (%)'), { target: { value: '51' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
    expect(screen.getByText('Enter a rate from 0 to 50 with up to 2 decimals.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('sends one rate per category for a by-category strategy', async () => {
    call.mockResolvedValue(ok(data()));
    mount(data({ strategies: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Add strategy' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mixed' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'by-category' } });
    fireEvent.change(screen.getByLabelText('Default rate (%)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rate for taxable (%)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rate for gst_free (%)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'tax/admin/strategies',
        {
          name: 'Mixed',
          kind: 'by-category',
          defaultRateBps: 1000,
          categoryRatesBps: { taxable: 1000, gst_free: 0 },
        },
        'csrf',
      ),
    );
  });

  it('edits through PUT', async () => {
    call.mockResolvedValue(ok(data()));
    mount(data());
    fireEvent.click(screen.getByRole('button', { name: 'Edit GST 10' }));
    fireEvent.change(screen.getByLabelText('Rate (%)'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'tax/admin/strategies/11111111-1111-4111-8111-111111111111',
        { name: 'GST 10', kind: 'flat-rate', rateBps: 1200 },
        'csrf',
      ),
    );
  });

  it('confirms before activating, and sends the id', async () => {
    call.mockResolvedValue(ok(data()));
    mount(data());
    fireEvent.click(screen.getByRole('button', { name: 'Activate GST 10' }));
    expect(screen.getByText(/It applies to new orders only/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'tax/admin/strategies/active',
        { strategyId: '11111111-1111-4111-8111-111111111111' },
        'csrf',
      ),
    );
  });

  it('puts the Market back on the built-in rate with a null id', async () => {
    call.mockResolvedValue(ok(data()));
    const active = strategy({ active: true });
    mount(data({ activeStrategyId: active.id, strategies: [active] }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to built-in rate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use built-in rate' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'tax/admin/strategies/active',
        { strategyId: null },
        'csrf',
      ),
    );
  });

  it('says why a delete was refused and keeps the dialog open', async () => {
    call.mockResolvedValueOnce(fail(409, 'tax.strategy-active'));
    mount(data());
    fireEvent.click(screen.getByRole('button', { name: 'Delete GST 10' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete strategy' }));
    expect(await screen.findByText(/This strategy is in force/)).toBeTruthy();
  });

  it('refreshes the list when the strategy is gone', async () => {
    call
      .mockResolvedValueOnce(fail(404, 'tax.strategy-not-found'))
      .mockResolvedValueOnce(ok(data({ strategies: [] })));
    mount(data());
    fireEvent.click(screen.getByRole('button', { name: 'Delete GST 10' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete strategy' }));
    expect(await screen.findByText('No tax strategies yet')).toBeTruthy();
  });
});
