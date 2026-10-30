// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { levelsProblemOf } from './levels-errors.ts';
import type { StockLevelsView } from './levels-types.ts';
import { onHandOf, StockLevels } from './stock-levels.tsx';
import type { SourceView } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const source = (id: string, name: string): SourceView => ({
  id,
  name,
  isDefault: false,
  position: 0,
  address: null,
  timeZone: null,
  createdAt: '2026-10-01T00:00:00Z',
});
const sources = [source('s1', 'Warehouse'), source('s2', 'Shop')];
const view: StockLevelsView = {
  offerId: 'o1',
  variants: [
    {
      variantId: 'v1',
      sources: [
        { variantId: 'v1', sourceId: 's1', onHand: 12, held: 2, version: 3, retired: false },
      ],
    },
  ],
};
const mount = (canEdit = true, v: StockLevelsView = view, s: SourceView[] = sources) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StockLevels offerId="o1" view={v} sources={s} canEdit={canEdit} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign: vi.fn() }, writable: true });
});
afterEach(cleanup);

describe('StockLevels', () => {
  it('saves a changed level with the version it read, then uses the new version', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { stockItemId: 'i1', onHand: 20, version: 4, changed: true },
    });
    mount();
    expect(screen.getByText('2 units held in checkouts')).toBeTruthy();
    const input = screen.getByLabelText('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o1/variants/v1/sources/s1/stock',
      { onHand: 20, expectedVersion: 3 },
      'csrf',
    );
    await expectToast('Saved.');
    fireEvent.change(input, { target: { value: '21' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toEqual({ onHand: 21, expectedVersion: 4 });
  });

  it('creates a level at a location with none yet (no expected version)', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { stockItemId: 'i2', onHand: 5, version: 1, changed: true },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1] as HTMLElement);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({ onHand: 5, expectedVersion: null });
  });

  it('refuses a non-number without calling the API, and shows a stale write', async () => {
    mount();
    const input = screen.getByLabelText('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    expect(await screen.findByText('Enter a whole number from 0 up.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0] as HTMLElement);
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is read only without the edit permission', () => {
    mount(false);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('points to the locations page when there are none', () => {
    mount(true, view, []);
    expect(screen.getByText('Add a stock location before you set stock levels.')).toBeTruthy();
  });
});

describe('stock level helpers', () => {
  it('accepts whole numbers up to the limit only', () => {
    expect(onHandOf('0')).toBe(0);
    expect(onHandOf(' 15 ')).toBe(15);
    for (const bad of ['', '-1', '1.5', 'x', '1000001']) expect(onHandOf(bad)).toBeNull();
  });
  it('maps failures to message names', () => {
    expect(levelsProblemOf({ status: 409, code: 'conflict.stale' })).toBe('stale');
    expect(levelsProblemOf({ status: 422, code: 'inventory.stock.below-held' })).toBe('below-held');
    expect(levelsProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(levelsProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
