// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import { expectToast } from '../../test/toast-spy.ts';
import { promotionsProblemOf } from './errors.ts';
import { PromotionsSettingsPanel } from './promotions-settings-panel.tsx';
import type { FirstOrderView, MarketSwitch, Thresholds } from './types.ts';

const call = vi.mocked(callApi);
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

const firstOrder = (over: Partial<FirstOrderView> = {}): FirstOrderView => ({
  source: 'stored',
  currency: 'AUD',
  settings: {
    enabled: true,
    kind: 'FIXED',
    percentBps: null,
    amountMinor: '800',
    capMinor: null,
    minSpendMinor: '3000',
    monthlyBudgetMinor: '100000',
  },
  ...over,
});
const thresholds = (): Thresholds => ({
  currency: 'AUD',
  defaultThresholdMinor: '5000',
  zones: [{ zoneCode: 'logan', thresholdMinor: '6000' }],
});
const on: MarketSwitch = { status: 'active', updatedAt: '2026-11-03T02:00:00.000Z' };
const off: MarketSwitch = { status: 'off', updatedAt: null };

/** The GET answers of an active market; a test overrides what it needs. */
function serve(order: FirstOrderView = firstOrder()) {
  call.mockImplementation((method, path) => {
    if (method === 'GET' && path === 'promotions/admin/first-order')
      return Promise.resolve(ok(order));
    if (method === 'GET' && path === 'promotions/admin/free-shipping')
      return Promise.resolve(ok(thresholds()));
    return Promise.resolve(refused(500, 'unexpected'));
  });
}
function mount(initial: MarketSwitch = on, manageSwitch = true, managePromotions = true) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PromotionsSettingsPanel
        initial={initial}
        canManageSwitch={manageSwitch}
        canManagePromotions={managePromotions}
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
}
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });
const save = () => fireEvent.click(within(bar()!).getByRole('button', { name: /^Save/ }));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('Settings → Promotions', () => {
  it('shows the switch, the first-order discount and the zones of an active market', async () => {
    serve();
    mount();
    expect(screen.getByRole('heading', { name: 'Promotions', level: 1 })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'First-order discount' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Amount off').value).toBe('8.00');
    expect(screen.getByLabelText<HTMLInputElement>('Minimum spend').value).toBe('30.00');
    expect(screen.getByLabelText<HTMLInputElement>('Monthly budget').value).toBe('1000.00');
    expect(screen.getByTestId('default-threshold').textContent).toContain('50.00');
    expect(screen.getByLabelText<HTMLInputElement>('Free delivery threshold for logan').value).toBe(
      '60.00',
    );
    expect(bar()).toBeNull();
  });

  it('does not read the cards while the market is off, and says why', () => {
    mount(off);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Promotions are off in this market/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'First-order discount' })).toBeNull();
  });

  it('lets a viewer see the switch only, with no save bar', () => {
    mount(on, false, false);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('View only')).toBeTruthy();
    expect(bar()).toBeNull();
  });

  it('shows a retry when the cards cannot be read', async () => {
    call.mockResolvedValue(refused(503, 'promotions.unavailable'));
    mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'First-order discount' })).toBeTruthy();
  });

  it('saves only what changed, with the amount in minor units', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'First-order discount' });
    type('Amount off', '9.50');
    expect(bar()).toBeTruthy();
    const base = firstOrder();
    const saved: FirstOrderView = {
      ...base,
      settings: { ...base.settings!, amountMinor: '950' },
    };
    call.mockResolvedValueOnce(ok(saved));
    save();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'promotions/admin/first-order',
        {
          enabled: true,
          kind: 'FIXED',
          amountMinor: '950',
          minSpendMinor: '3000',
          monthlyBudgetMinor: '100000',
        },
        'csrf',
      ),
    );
    await waitFor(() => expect(bar()).toBeNull());
    expect(screen.getByLabelText<HTMLInputElement>('Amount off').value).toBe('9.50');
    await expectToast('Promotions settings saved. They apply to orders placed from now on.');
    // Nothing else was written.
    expect(call.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1);
  });

  it('does not send a bad amount and names the field', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'First-order discount' });
    type('Amount off', 'abc');
    save();
    expect((await screen.findAllByText(/Enter an amount above zero/)).length).toBeGreaterThan(0);
    expect(call.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(0);
  });

  it('writes a changed zone, a zone back to the default and a new zone', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'Free delivery threshold' });
    type('Free delivery threshold for logan', '65');
    fireEvent.change(screen.getByLabelText('Add a zone'), { target: { value: 'gold-coast' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    type('Free delivery threshold for gold-coast', '75');
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        ok({
          zoneCode: String(path).split('/').pop(),
          thresholdMinor: path === 'promotions/admin/free-shipping/logan' ? '6500' : '7500',
        }),
      ),
    );
    save();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'promotions/admin/free-shipping/logan',
        { thresholdMinor: '6500' },
        'csrf',
      ),
    );
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'promotions/admin/free-shipping/gold-coast',
      { thresholdMinor: '7500' },
      'csrf',
    );
  });

  it('sends null for a zone that goes back to the market default', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'Free delivery threshold' });
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    expect(screen.getByText('Uses the market default.')).toBeTruthy();
    call.mockResolvedValueOnce(ok({ zoneCode: 'logan', thresholdMinor: null }));
    save();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'promotions/admin/free-shipping/logan',
        { thresholdMinor: null },
        'csrf',
      ),
    );
    await waitFor(() => expect(screen.queryByText('Uses the market default.')).toBeNull());
  });

  it('refuses a zone code with a slash', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'Free delivery threshold' });
    fireEvent.change(screen.getByLabelText('Add a zone'), { target: { value: 'a/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/letters, numbers, dashes/i)).toBeTruthy();
  });

  it('turns promotions on, then reads the cards', async () => {
    mount(off);
    fireEvent.click(screen.getByRole('checkbox'));
    serve();
    call.mockResolvedValueOnce(ok({ status: 'active', updatedAt: '2026-11-11T05:00:00.000Z' }));
    save();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'promotions/admin/settings',
        { status: 'active' },
        'csrf',
      ),
    );
    expect(await screen.findByRole('heading', { name: 'First-order discount' })).toBeTruthy();
  });

  it('keeps the page as it was when the sign-in code dialog is closed', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'First-order discount' });
    type('Monthly budget', '5000');
    call.mockResolvedValueOnce(refused(0, STEP_UP_CANCELLED));
    save();
    await waitFor(() => expect(call.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(1));
    expect(bar()).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names a refusal that comes from acting as a seller, and discards back to the saved values', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'First-order discount' });
    type('Amount off', '12');
    call.mockResolvedValueOnce(refused(403, 'access.denied'));
    save();
    expect(await screen.findByText(/You can't change this/)).toBeTruthy();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText<HTMLInputElement>('Amount off').value).toBe('8.00');
    expect(screen.queryByText(/You can't change this/)).toBeNull();
  });

  it('goes back to Off when the API says promotions are disabled', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'First-order discount' });
    type('Amount off', '12');
    call.mockResolvedValueOnce(refused(404, 'promotions.disabled'));
    save();
    expect(
      await screen.findByText(/Promotions are off in this market. Turn them on first/),
    ).toBeTruthy();
  });
});

describe('roles', () => {
  it('lets a promotions manager without the switch key change the cards but not the switch', async () => {
    serve();
    mount(on, false, true);
    await screen.findByRole('heading', { name: 'First-order discount' });
    expect(screen.getAllByRole<HTMLInputElement>('checkbox')[0]!.disabled).toBe(true);
    type('Amount off', '9');
    call.mockResolvedValueOnce(ok(firstOrder()));
    save();
    await waitFor(() =>
      expect(
        call.mock.calls.some(([m, p]) => m === 'PUT' && p === 'promotions/admin/first-order'),
      ).toBe(true),
    );
    expect(call.mock.calls.some(([, p]) => p === 'promotions/admin/settings')).toBe(false);
  });

  it('shows a switch-only manager no cards and reads nothing', () => {
    mount(on, true, false);
    expect(call).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'First-order discount' })).toBeNull();
    expect(screen.getByText(/need the promotions manage permission/)).toBeTruthy();
  });

  it('adds a zone on Enter without saving the page', async () => {
    serve();
    mount();
    await screen.findByRole('heading', { name: 'Free delivery threshold' });
    const input = screen.getByLabelText('Add a zone');
    fireEvent.change(input, { target: { value: 'ipswich' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByLabelText('Free delivery threshold for ipswich')).toBeTruthy();
    expect(call.mock.calls.filter(([m]) => m === 'PUT')).toHaveLength(0);
  });
});

describe('promotionsProblemOf', () => {
  it('words the API refusals', () => {
    expect(promotionsProblemOf({ status: 400, code: 'validation.failed' })).toBe('invalid');
    expect(promotionsProblemOf({ status: 404, code: 'promotions.disabled' })).toBe('disabled');
    expect(promotionsProblemOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(promotionsProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(promotionsProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
