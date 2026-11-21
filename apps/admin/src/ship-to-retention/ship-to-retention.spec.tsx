// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, Toaster } from '@mondapac/ui';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { shipToRetentionProblemOf } from './errors.ts';
import { monthsOf, needsConfirm } from './form.ts';
import { ShipToRetentionPanel } from './retention-panel.tsx';
import type { ShipToRetention } from './types.ts';

const call = vi.mocked(callApi);
const PATH = 'ordering/admin/ship-to-retention';
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>{node}</StepUpProvider>
    <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
  </NextIntlClientProvider>
);
const setting = (patch: Partial<ShipToRetention> = {}): ShipToRetention => ({
  enabled: false,
  months: 24,
  version: 0,
  updatedAt: null,
  updatedBy: null,
  ...patch,
});
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const refused = (status: number, code: string, details?: object): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const panel = (initial: ShipToRetention, canManage = true) =>
  render(
    wrap(
      <ShipToRetentionPanel initial={initial} canManage={canManage} csrfToken="csrf" zone="UTC" />,
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

describe('helpers', () => {
  it('takes whole months from 1 to 120 only', () => {
    expect(monthsOf('1')).toBe(1);
    expect(monthsOf('120')).toBe(120);
    for (const bad of ['', '0', '121', '1.5', '-3', 'abc', '1e2']) expect(monthsOf(bad)).toBeNull();
  });

  it('asks to confirm when turning on or shortening, not when turning off or lengthening', () => {
    const off = { enabled: false, months: 24 };
    const on = { enabled: true, months: 24 };
    expect(needsConfirm(off, on)).toBe(true);
    expect(needsConfirm(on, { enabled: true, months: 12 })).toBe(true);
    expect(needsConfirm(on, { enabled: true, months: 36 })).toBe(false);
    expect(needsConfirm(on, { enabled: false, months: 24 })).toBe(false);
  });

  it('names the message for each failure', () => {
    expect(shipToRetentionProblemOf({ status: 409, code: 'conflict.retry' })).toBe('stale');
    expect(shipToRetentionProblemOf({ status: 400, code: 'validation.failed' })).toBe('invalid');
    expect(shipToRetentionProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
  });
});

describe('ship-to retention panel', () => {
  it('shows it off by default, with the permanence warning and no months field', () => {
    panel(setting());
    expect(screen.getByRole('switch', { name: 'Delete delivery addresses' })).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Deletion is permanent/)).toBeTruthy();
    expect(screen.queryByLabelText('Months after the order is completed')).toBeNull();
    expect(screen.getByText('Not set yet: deletion is off.')).toBeTruthy();
  });

  it('is view only without the manage key', () => {
    panel(
      setting({ enabled: true, months: 12, version: 2, updatedAt: '2026-11-10T01:00:00Z' }),
      false,
    );
    expect(screen.getByText(/You can see this setting but not change it/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('switch').disabled).toBe(true);
    expect(
      screen.getByLabelText<HTMLInputElement>('Months after the order is completed').disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByText(/Version 2/)).toBeTruthy();
  });

  it('turns on with a confirm step and a step-up code, prefilled with 24 months', async () => {
    panel(setting());
    fireEvent.click(screen.getByRole('switch'));
    const months = screen.getByLabelText<HTMLInputElement>('Months after the order is completed');
    expect(months.value).toBe('24');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(call).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: 'Delete delivery addresses permanently?' });
    expect(within(confirm).getByText(/completed at least 24 months ago/)).toBeTruthy();
    expect(
      within(confirm).getByText(/cancelled, refunded in full, or shipped but never delivered/),
    ).toBeTruthy();

    call
      .mockResolvedValueOnce(
        refused(403, 'second-factor.required', { actionKey: 'ordering.ship-to-retention.change' }),
      )
      .mockResolvedValueOnce(ok({ ok: true } as never))
      .mockResolvedValueOnce(
        ok(setting({ enabled: true, version: 1, updatedAt: '2026-11-15T01:00:00Z' })),
      );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Save and delete permanently' }));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Confirm|code|Enter/i })).toBeTruthy(),
    );
    expect(call.mock.calls[0]).toEqual([
      'PUT',
      PATH,
      { enabled: true, months: 24, expectedVersion: 0 },
      'csrf',
    ]);
  });

  it('saves a turn-off without a confirm step, keeping the saved months', async () => {
    panel(setting({ enabled: true, months: 12, version: 3, updatedAt: '2026-11-10T01:00:00Z' }));
    fireEvent.click(screen.getByRole('switch'));
    call.mockResolvedValueOnce(
      ok(setting({ enabled: false, months: 12, version: 4, updatedAt: '2026-11-15T01:00:00Z' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText(/Version 4/)).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      PATH,
      { enabled: false, months: 12, expectedVersion: 3 },
      'csrf',
    );
  });

  it('confirms before shortening but not before lengthening', async () => {
    panel(setting({ enabled: true, months: 24, version: 1, updatedAt: '2026-11-10T01:00:00Z' }));
    fireEvent.change(screen.getByLabelText('Months after the order is completed'), {
      target: { value: '36' },
    });
    call.mockResolvedValueOnce(
      ok(setting({ enabled: true, months: 36, version: 2, updatedAt: '2026-11-15T01:00:00Z' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/Version 2/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Months after the order is completed'), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('dialog', { name: 'Delete delivery addresses permanently?' }),
    ).toBeTruthy();
  });

  it('shows the save bar only with a change, counts the changes and discards them', () => {
    panel(setting({ enabled: true, months: 24, version: 1, updatedAt: '2026-11-10T01:00:00Z' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Months after the order is completed'), {
      target: { value: '30' },
    });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText(/1 unsaved change/)).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(
      screen.getByLabelText<HTMLInputElement>('Months after the order is completed').value,
    ).toBe('24');
    expect(call).not.toHaveBeenCalled();
  });

  it('disables Save while the months need fixing, and enables it once they are fixed', () => {
    panel(setting());
    fireEvent.click(screen.getByRole('switch'));
    const months = screen.getByLabelText('Months after the order is completed');
    fireEvent.change(months, { target: { value: '0' } });
    expect(screen.getByText(/2 unsaved changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/1 needs fixing/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      true,
    );
    fireEvent.change(months, { target: { value: '12' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      false,
    );
  });

  it.each(['0', '121', '1.5', ''])('refuses %j months before sending', (value) => {
    panel(setting());
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByLabelText('Months after the order is completed'), {
      target: { value },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a whole number of months from 1 to 120.')).toBeTruthy();
  });

  it('on a stale 409 shows the message and reloads the latest on request', async () => {
    panel(setting({ enabled: true, months: 24, version: 1, updatedAt: '2026-11-10T01:00:00Z' }));
    fireEvent.change(screen.getByLabelText('Months after the order is completed'), {
      target: { value: '30' },
    });
    call.mockResolvedValueOnce(refused(409, 'conflict.retry'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.getByText(/Another admin changed this setting first/)).toBeTruthy(),
    );
    call.mockResolvedValueOnce(
      ok(setting({ enabled: true, months: 18, version: 2, updatedAt: '2026-11-14T01:00:00Z' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(screen.getByText(/Version 2/)).toBeTruthy());
    expect(call).toHaveBeenLastCalledWith('GET', PATH);
    expect(
      screen.getByLabelText<HTMLInputElement>('Months after the order is completed').value,
    ).toBe('18');
    expect(screen.queryByText(/Another admin changed/)).toBeNull();
  });
});
