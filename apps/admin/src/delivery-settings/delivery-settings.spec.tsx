// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { deliveryProblemOf } from './errors.ts';
import { DeliverySettingsPanel } from './delivery-settings-panel.tsx';
import {
  basisPointsOf,
  checkForm,
  EXAMPLE_QUOTE_MINOR,
  formOf,
  percentText,
  priceOf,
} from './form.ts';
import { SellerMethodsCard } from './seller-methods-card.tsx';
import type { DeliverySettings, SellerMethods } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode, locale = 'en-AU') => (
  <NextIntlClientProvider locale={locale} messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const settings = (patch: Partial<DeliverySettings> = {}): DeliverySettings => ({
  enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
  sameDayCutoff: '12:00',
  scheduledDaysAhead: 7,
  scheduledWindowMinutes: 120,
  margin: { kind: 'none' },
  roundingStepMinor: 1,
  version: 0,
  currency: 'AUD',
  marketZone: 'Australia/Brisbane',
  roundingSteps: [1, 5, 10, 50, 100],
  ...patch,
});
const mount = (initial: DeliverySettings, canManage = true, locale = 'en-AU') =>
  render(
    wrap(
      <DeliverySettingsPanel initial={initial} canManage={canManage} csrfToken="csrf" />,
      locale,
    ),
  );
const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

vi.setConfig({ testTimeout: 30_000 });

const flat = (text: string | null) => (text ?? '').replaceAll('\u00a0', ' ');
/** The dialog is a native modal; jsdom keeps it in the tree, so its buttons are reachable. */
const pressInDialog = (name: string) =>
  fireEvent.click(screen.getByRole('button', { name, hidden: true }));

beforeEach(() => {
  vi.resetAllMocks();
  // jsdom has no modal support: a stub makes `showModal` open the element.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the margin example', () => {
  it('turns A$12.34 into A$13.60 with 10 percent and a 5c round-up', () => {
    expect(priceOf(EXAMPLE_QUOTE_MINOR, { kind: 'percent', basisPoints: 1000 }, 5)).toEqual({
      quote: 1234,
      margin: 126,
      total: 1360,
    });
  });

  it('adds a fixed amount, rounds up only, and leaves a quote alone with no margin', () => {
    expect(priceOf(1234, { kind: 'fixed', amountMinor: 150 }, 1)).toEqual({
      quote: 1234,
      margin: 150,
      total: 1384,
    });
    expect(priceOf(1234, { kind: 'none' }, 100)).toEqual({ quote: 1234, margin: 66, total: 1300 });
    expect(priceOf(1300, { kind: 'none' }, 100).total).toBe(1300);
    // 12.5 % of 100 is 12.5, which rounds half-up to 13 like the API does.
    expect(priceOf(100, { kind: 'percent', basisPoints: 1250 }, 1).margin).toBe(13);
  });
});

describe('the form checks', () => {
  it('reads a percent as basis points, with at most two decimals up to 100', () => {
    expect(['10', '12.5', '0.25', '100', ' 7 '].map(basisPointsOf)).toEqual([
      1000, 1250, 25, 10000, 700,
    ]);
    expect(['100.01', '101', '-1', '1.234', '', 'x'].map(basisPointsOf)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect([1000, 1250, 25, 0, 10000].map(percentText)).toEqual(['10', '12.5', '0.25', '0', '100']);
  });

  it('builds the body and flags the cut-off, the days and the margin', () => {
    const base = formOf(settings());
    expect(checkForm(base, 'AUD')).toEqual({
      ok: true,
      body: {
        enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
        sameDayCutoff: '12:00',
        scheduledDaysAhead: 7,
        scheduledWindowMinutes: 120,
        margin: { kind: 'none' },
        roundingStepMinor: 1,
      },
    });
    expect(
      checkForm(
        { ...base, cutoff: '25:00', daysAhead: '0', marginKind: 'percent', marginValue: '' },
        'AUD',
      ),
    ).toEqual({ ok: false, invalid: ['cutoff', 'daysAhead', 'marginValue'] });
    expect(checkForm({ ...base, daysAhead: '31' }, 'AUD')).toEqual({
      ok: false,
      invalid: ['daysAhead'],
    });
  });

  it('reads a fixed margin in the currency of the Market', () => {
    const base = formOf(settings());
    const fixed = (marginValue: string, currency: string) =>
      checkForm({ ...base, marginKind: 'fixed', marginValue }, currency);
    expect(fixed('1.50', 'AUD')).toMatchObject({
      ok: true,
      body: { margin: { amountMinor: 150 } },
    });
    expect(fixed('150', 'JPY')).toMatchObject({ ok: true, body: { margin: { amountMinor: 150 } } });
    expect(fixed('1.5', 'JPY')).toEqual({ ok: false, invalid: ['marginValue'] });
    expect(fixed('1.505', 'AUD')).toEqual({ ok: false, invalid: ['marginValue'] });
    expect(fixed('10000.01', 'AUD')).toEqual({ ok: false, invalid: ['marginValue'] });
  });

  it('shows a stored fixed margin as major units', () => {
    expect(formOf(settings({ margin: { kind: 'fixed', amountMinor: 150 } })).marginValue).toBe(
      '1.50',
    );
    expect(
      formOf(settings({ currency: 'JPY', margin: { kind: 'fixed', amountMinor: 150 } }))
        .marginValue,
    ).toBe('150');
  });

  it('names the message of each refusal', () => {
    const failure = (status: number, code: string) => ({ status, code });
    expect(deliveryProblemOf(failure(409, 'shipping.delivery-settings-conflict'))).toBe('conflict');
    expect(deliveryProblemOf(failure(400, 'validation.failed'))).toBe('invalid');
    expect(deliveryProblemOf(failure(404, 'shipping.seller-not-found'))).toBe('not-found');
    expect(deliveryProblemOf(failure(503, 'shipping.unavailable'))).toBe('unavailable');
    expect(deliveryProblemOf(failure(500, 'internal'))).toBe('unknown');
  });
});

describe('the delivery settings page', () => {
  it('says the defaults apply before anything was saved, and shows them', () => {
    mount(settings());

    expect(screen.getByText(/Nothing has been saved yet/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Cut-off time').value).toBe('12:00');
    expect(screen.getByLabelText<HTMLInputElement>('Days ahead').value).toBe('7');
    expect(screen.getByLabelText<HTMLSelectElement>('Window length').value).toBe('120');
    expect(screen.getByLabelText<HTMLSelectElement>('Margin').value).toBe('none');
    for (const name of [
      'In-person pickup',
      'Instant delivery',
      'Same-day delivery',
      'Scheduled delivery',
    ]) {
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name }).checked).toBe(true);
    }
  });

  it('shows the live example for a percentage and a round-up, and follows the inputs', () => {
    mount(settings({ version: 1 }));

    expect(flat(screen.getByTestId('margin-example').textContent)).toBe(
      'A fleet quote of AUD 12.34 stays AUD 12.34 for the buyer: no margin added.',
    );
    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'percent' } });
    expect(screen.getByText('Enter a valid margin to see an example.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Percentage'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rounding'), { target: { value: '5' } });

    expect(flat(screen.getByTestId('margin-example').textContent)).toBe(
      'A fleet quote of AUD 12.34 becomes AUD 13.60 for the buyer (margin AUD 1.26 included).',
    );
  });

  it('counts the rounding steps in the currency of the Market', () => {
    mount(settings({ currency: 'JPY' }), true, 'ja-JP');

    const options = within(screen.getByLabelText('Rounding'))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options[0]).toBe('No rounding');
    expect(options.map(flat)).toContain('Round up to JPY 50');
    expect(flat(screen.getByTestId('margin-example').textContent)).toContain('JPY 1,234');
  });

  it('is read-only without the manage permission', () => {
    mount(settings({ version: 2 }), false);

    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Instant delivery').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Window length').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Cut-off time').disabled).toBe(true);
    expect(screen.getByText(/You can view these settings but not change them/)).toBeTruthy();
  });

  it('saves the whole set with the version read and shows the answer', async () => {
    const saved = settings({
      enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
      sameDayCutoff: '10:30',
      scheduledDaysAhead: 3,
      scheduledWindowMinutes: 90,
      margin: { kind: 'percent', basisPoints: 1000 },
      roundingStepMinor: 5,
      version: 1,
    });
    call.mockResolvedValue(ok(saved));
    mount(settings());

    fireEvent.click(screen.getByLabelText('Instant delivery'));
    fireEvent.change(screen.getByLabelText('Cut-off time'), { target: { value: '10:30' } });
    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Window length'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Percentage'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rounding'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(call).not.toHaveBeenCalled();
    pressInDialog('Confirm and save');

    await expectToast(/Delivery settings saved/);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'shipping/admin/delivery-settings',
      {
        enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
        sameDayCutoff: '10:30',
        scheduledDaysAhead: 3,
        scheduledWindowMinutes: 90,
        margin: { kind: 'percent', basisPoints: 1000 },
        roundingStepMinor: 5,
        expectedVersion: 0,
      },
      'csrf',
    );
    expect(screen.queryByText(/Nothing has been saved yet/)).toBeNull();
  });

  it('lists each change in plain words and sends nothing until confirmed', () => {
    mount(settings({ version: 1 }));

    fireEvent.click(screen.getByLabelText('Instant delivery'));
    fireEvent.change(screen.getByLabelText('Cut-off time'), { target: { value: '14:00' } });
    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Percentage'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rounding'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = within(
      screen.getByRole('dialog', { name: 'Save these delivery settings?', hidden: true }),
    );
    const text = flat(dialog.getByRole('list', { hidden: true }).textContent);
    expect(text).toContain('Instant delivery will be unavailable for all sellers in this Market.');
    expect(text).toContain('Sellers can’t receive Instant delivery orders');
    expect(text).toContain('Same-day orders will close at 14:00 seller’s local time (now 12:00).');
    expect(text).toContain('Buyers will pay +10% on every delivery (rounded up to AUD 0.10).');
    expect(call).not.toHaveBeenCalled();

    pressInDialog('Keep editing');
    expect(call).not.toHaveBeenCalled();
  });

  it('puts the error on the field, lists it in the summary and moves focus to the summary', () => {
    mount(settings());

    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Percentage'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const field = screen.getByLabelText<HTMLInputElement>('Percentage');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    const summary = screen.getByRole('alert');
    expect(summary.textContent).toContain('1 setting needs fixing before you can save');
    expect(document.activeElement).toBe(summary);
    fireEvent.click(within(summary).getByRole('link', { name: 'Percentage' }));
    expect(document.activeElement).toBe(field);
    // Typing in the field takes its error away.
    fireEvent.change(field, { target: { value: '12' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('marks each changed field, counts them in the save bar and discards them', () => {
    mount(settings({ version: 1 }));

    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Instant delivery'));
    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '9' } });

    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('2 unsaved changes');
    expect(screen.getByLabelText('Days ahead').className).toContain('ring-attention-border');
    expect(screen.getByLabelText('Cut-off time').className).not.toContain('ring-attention-border');
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Days ahead').value).toBe('7');
    expect(screen.getByLabelText<HTMLInputElement>('Instant delivery').checked).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it('flags a bad form without calling the API', () => {
    mount(settings());

    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Margin'), { target: { value: 'fixed' } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '1.505' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByText('Enter a whole number of days from 1 to 30.')).toBeTruthy();
    expect(screen.getByText(/Enter an amount up to/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows what is stored after someone saved first', async () => {
    call
      .mockResolvedValueOnce(refused(409, 'shipping.delivery-settings-conflict'))
      .mockResolvedValueOnce(ok(settings({ scheduledDaysAhead: 4, version: 5 })));
    mount(settings({ version: 4 }));

    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    pressInDialog('Confirm and save');

    await waitFor(() =>
      expect(screen.getByText(/Someone saved these settings first/)).toBeTruthy(),
    );
    expect(screen.getByText('These settings changed while you were editing')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'shipping/admin/delivery-settings');
    expect(screen.getByLabelText<HTMLInputElement>('Days ahead').value).toBe('4');
  });

  it('says what went wrong when the API refuses', async () => {
    call.mockResolvedValue(refused(403, 'access.denied'));
    mount(settings());

    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    pressInDialog('Confirm and save');

    await waitFor(() =>
      expect(screen.getByText('Your role cannot change delivery settings.')).toBeTruthy(),
    );
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValue(refused(401, 'session.invalid'));
    mount(settings());

    fireEvent.change(screen.getByLabelText('Days ahead'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    pressInDialog('Confirm and save');

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const methods = (patch: Partial<SellerMethods> = {}): SellerMethods => ({
  sellerId: SELLER,
  supported: ['pickup', 'instant', 'same_day', 'scheduled'],
  platformEnabled: { pickup: true, instant: true, same_day: true, scheduled: true },
  ...patch,
});
const mountSeller = (initial: SellerMethods, canManage = true) =>
  render(wrap(<SellerMethodsCard initial={initial} canManage={canManage} csrfToken="csrf" />));

describe('the seller delivery methods card', () => {
  it('ticks what the seller supports and marks a method the Market has off', () => {
    mountSeller(
      methods({
        supported: ['pickup', 'scheduled'],
        platformEnabled: { pickup: true, instant: true, same_day: false, scheduled: true },
      }),
    );

    expect(screen.getByLabelText<HTMLInputElement>('Instant delivery').checked).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('In-person pickup').checked).toBe(true);
    const off = screen.getByLabelText<HTMLInputElement>(
      'Same-day delivery (off for the whole Market)',
    );
    expect(off.disabled).toBe(true);
    expect(
      screen.getAllByText(/Buyers see this as unavailable whatever is ticked here/),
    ).toHaveLength(1);
    expect(screen.getByText(/the Market switch overrides this card/)).toBeTruthy();
  });

  it('is read-only without the manage permission', () => {
    mountSeller(methods(), false);

    expect(screen.queryByRole('button', { name: 'Save delivery methods' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Instant delivery').disabled).toBe(true);
  });

  it('sends the methods that stay, in the fixed order', async () => {
    call.mockResolvedValue(ok(methods({ supported: ['pickup', 'same_day', 'scheduled'] })));
    mountSeller(methods());

    fireEvent.click(screen.getByLabelText('Instant delivery'));
    fireEvent.click(screen.getByRole('button', { name: 'Save delivery methods' }));
    expect(call).not.toHaveBeenCalled();
    expect(flat(screen.getByRole('dialog', { hidden: true }).textContent)).toContain(
      'The seller can’t receive Instant delivery orders.',
    );
    pressInDialog('Confirm and save');

    await expectToast(/Delivery methods saved/);
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `shipping/admin/sellers/${SELLER}/delivery-methods`,
      { supported: ['pickup', 'same_day', 'scheduled'] },
      'csrf',
    );
  });

  it('can take every method away, and says when the API refuses', async () => {
    call.mockResolvedValue(refused(404, 'shipping.seller-not-found'));
    mountSeller(methods({ supported: ['instant'] }));

    fireEvent.click(screen.getByLabelText('Instant delivery'));
    fireEvent.click(screen.getByRole('button', { name: 'Save delivery methods' }));
    pressInDialog('Confirm and save');

    await waitFor(() => expect(screen.getByText('We could not find this seller.')).toBeTruthy());
    expect(call.mock.calls[0]?.[2]).toEqual({ supported: [] });
  });
});

describe('the seller card after a conflict', () => {
  it('reloads what is stored and says so', async () => {
    call
      .mockResolvedValueOnce(refused(409, 'shipping.delivery-settings-conflict'))
      .mockResolvedValueOnce(ok(methods({ supported: ['pickup'] })));
    mountSeller(methods());

    fireEvent.click(screen.getByLabelText('Instant delivery'));
    fireEvent.click(screen.getByRole('button', { name: 'Save delivery methods' }));
    pressInDialog('Confirm and save');

    await waitFor(() => expect(screen.getByText(/Someone changed this first/)).toBeTruthy());
    expect(call).toHaveBeenNthCalledWith(
      2,
      'GET',
      `shipping/admin/sellers/${SELLER}/delivery-methods`,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Same-day delivery').checked).toBe(false);
  });
});

describe('right-to-left readiness', () => {
  // The admin has one English catalogue and a fixed `dir="ltr"` today. When a Persian catalogue
  // arrives the page must mirror without edits, so it uses logical spacing and alignment only.
  it('uses no physical left or right classes', () => {
    const files = readdirSync(__dirname).filter(
      (name) => /\.tsx$/.test(name) && !/spec/.test(name),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text, file).not.toMatch(
        /\b(?:m|p)[lr]-\d|\btext-(?:left|right)\b|\b(?:left|right)-\d/,
      );
    }
  });
});
