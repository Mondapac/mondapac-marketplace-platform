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
const assign = vi.fn();
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

const pressSave = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const two: StockLevelsView = {
  offerId: 'o1',
  variants: [
    {
      variantId: 'v1',
      sources: [
        { variantId: 'v1', sourceId: 's1', onHand: 12, held: 2, version: 3, retired: false },
        { variantId: 'v1', sourceId: 's2', onHand: 4, held: 0, version: 7, retired: false },
      ],
    },
  ],
};
const stored = (onHand: number, version: number) => ({
  ok: true as const,
  status: 200,
  body: { stockItemId: 'i', onHand, version, changed: true },
});

describe('StockLevels', () => {
  it('shows no bar until a level changes, and Discard puts it back', () => {
    mount();
    expect(bar()).toBeNull();
    const input = screen.getByLabelText<HTMLInputElement>('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '20' } });
    expect(bar()?.textContent).toContain('1 unsaved change');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input.value).toBe('12');
    expect(bar()).toBeNull();
  });

  it('saves a changed level with the version it read, then uses the new version', async () => {
    call.mockResolvedValue(stored(20, 4));
    mount();
    expect(screen.getByText('2 units held in checkouts')).toBeTruthy();
    const input = screen.getByLabelText('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '20' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/offers/o1/variants/v1/sources/s1/stock',
      { onHand: 20, expectedVersion: 3 },
      'csrf',
    );
    await expectToast('Saved.');
    await waitFor(() => expect(bar()).toBeNull());
    fireEvent.change(input, { target: { value: '21' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toEqual({ onHand: 21, expectedVersion: 4 });
  });

  it('saves every changed level in turn and says so once', async () => {
    call.mockResolvedValueOnce(stored(20, 4)).mockResolvedValueOnce(stored(9, 8));
    mount(true, two);
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: '20' },
    });
    expect(bar()?.textContent).toContain('2 unsaved changes');
    pressSave();
    await expectToast('2 levels saved.');
    expect(call.mock.calls.map((c) => c[1])).toEqual([
      'inventory/seller/offers/o1/variants/v1/sources/s1/stock',
      'inventory/seller/offers/o1/variants/v1/sources/s2/stock',
    ]);
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('keeps a refused level and its message while the next one saves', async () => {
    call
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 422, code: 'inventory.stock.below-held' },
      })
      .mockResolvedValueOnce(stored(9, 8));
    mount(true, two);
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '9' } });
    pressSave();
    await expectToast(/1 level saved; 1 needs attention/, 'warning');
    expect(screen.getByText(/below the units held/)).toBeTruthy();
    await waitFor(() => expect(bar()?.textContent).toContain('1 unsaved change'));
  });

  it('creates a level at a location with none yet (no expected version)', async () => {
    call.mockResolvedValue(stored(5, 1));
    mount();
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '5' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({ onHand: 5, expectedVersion: null });
  });

  it('refuses a non-number without calling the API, and shows a stale write', async () => {
    mount();
    const input = screen.getByLabelText('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '-1' } });
    pressSave();
    expect(await screen.findByText('Enter a whole number from 0 up.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    fireEvent.change(input, { target: { value: '7' } });
    pressSave();
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    await expectToast(/Nothing was saved/, 'error');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('takes the reloaded version after a stale write and keeps the typed number', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    const view0 = mount();
    const input = screen.getByLabelText<HTMLInputElement>('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '7' } });
    pressSave();
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    const reloaded: StockLevelsView = {
      offerId: 'o1',
      variants: [
        {
          variantId: 'v1',
          sources: [
            { variantId: 'v1', sourceId: 's1', onHand: 15, held: 2, version: 5, retired: false },
          ],
        },
      ],
    };
    view0.rerender(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <StockLevels offerId="o1" view={reloaded} sources={sources} canEdit csrfToken="csrf" />
      </NextIntlClientProvider>,
    );
    expect(input.value).toBe('7');
    call.mockResolvedValueOnce(stored(7, 6));
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]?.[2]).toEqual({ onHand: 7, expectedVersion: 5 });
  });

  it('leaves quietly for the session-ended page when signed out', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'auth.required' } });
    mount();
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: '3' },
    });
    pressSave();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
  });

  it('shows the stored number once a stale level is reloaded, and clears the message on typing', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    const view0 = mount();
    const input = screen.getByLabelText('Units in stock at Warehouse');
    fireEvent.change(input, { target: { value: '7' } });
    pressSave();
    expect(await screen.findByText(/Loading the stored number/)).toBeTruthy();
    view0.rerender(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <StockLevels
          offerId="o1"
          view={{
            offerId: 'o1',
            variants: [
              {
                variantId: 'v1',
                sources: [
                  {
                    variantId: 'v1',
                    sourceId: 's1',
                    onHand: 15,
                    held: 2,
                    version: 5,
                    retired: false,
                  },
                ],
              },
            ],
          }}
          sources={sources}
          canEdit
          csrfToken="csrf"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/It is now 15/)).toBeTruthy();
    fireEvent.change(input, { target: { value: '8' } });
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  it('keeps a level saved after the refresh was asked for when an older snapshot arrives', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } })
      .mockResolvedValueOnce(stored(9, 8));
    const view0 = mount(true, two);
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '9' } });
    pressSave();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Units in stock at Shop').value).toBe('9'),
    );
    // The refresh answers with what was stored before the Shop save (version 7).
    view0.rerender(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <StockLevels offerId="o1" view={two} sources={sources} canEdit csrfToken="csrf" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Units in stock at Shop').value).toBe('9');
  });

  it('marks every wrong number, sends nothing, and focuses the first', async () => {
    mount(true, two);
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: 'x' },
    });
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '-2' } });
    pressSave();
    await waitFor(() =>
      expect(screen.getAllByText('Enter a whole number from 0 up.')).toHaveLength(2),
    );
    expect(call).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Units in stock at Warehouse')),
    );
  });

  it('focuses the refused number after a partial save', async () => {
    call.mockResolvedValueOnce(stored(20, 4)).mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, code: 'inventory.stock.below-held' },
    });
    mount(true, two);
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '0' } });
    pressSave();
    await expectToast(/1 level saved; 1 needs attention/, 'warning');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Units in stock at Shop')),
    );
  });

  it('sends nothing after a signed-out answer', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'auth.required' } });
    mount(true, two);
    fireEvent.change(screen.getByLabelText('Units in stock at Warehouse'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '5' } });
    pressSave();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows a retired level as text, outside the count', () => {
    mount(true, {
      offerId: 'o1',
      variants: [
        {
          variantId: 'v1',
          sources: [
            { variantId: 'v1', sourceId: 's1', onHand: 12, held: 2, version: 3, retired: true },
          ],
        },
      ],
    });
    expect(screen.queryByLabelText('Units in stock at Warehouse')).toBeNull();
    expect(screen.getByText('12')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Units in stock at Shop'), { target: { value: '1' } });
    expect(bar()?.textContent).toContain('1 unsaved change');
  });

  it('is read only without the edit permission', () => {
    mount(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(bar()).toBeNull();
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
