// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { settingsTabs } from '../settings/settings-header.tsx';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { DeliverySettings } from './delivery-settings.tsx';
import { problemOf } from './errors.ts';
import { CLOCK_TIMES, CLOSE_TIMES, problemsOf, type DeliverySettingsView } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const SET = { day: 'same-day', from: '09:00', to: '12:30', cutoff: '08:30' } as const;
const none = (): DeliverySettingsView => ({ version: 3, delivery: null });
const set = (): DeliverySettingsView => ({ version: 4, delivery: SET });
const ok = (body: DeliverySettingsView) => ({ ok: true as const, status: 200, body });
const refused = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

const mount = (initial = none(), canEdit = true) =>
  render(wrap(<DeliverySettings initial={initial} csrfToken="csrf" canEdit={canEdit} />));
const field = (name: RegExp) => screen.getByLabelText<HTMLSelectElement>(name);
const pick = (name: RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save delivery times' }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DeliverySettings', () => {
  it('says no terms are set and offers sensible defaults, without a remove button', () => {
    mount();

    expect(screen.getByText(/You have not set your delivery times yet/)).toBeTruthy();
    expect(field(/Orders placed before the cut-off arrive/).value).toBe('next-day');
    expect(field(/Window opens/).value).toBe('08:00');
    expect(field(/Window closes/).value).toBe('12:00');
    expect(field(/Order cut-off/).value).toBe('14:00');
    expect(screen.queryByRole('button', { name: 'Remove delivery times' })).toBeNull();
  });

  it('shows the saved terms and the remove button', () => {
    mount(set());

    expect(screen.queryByText(/You have not set your delivery times yet/)).toBeNull();
    expect(field(/Orders placed before the cut-off arrive/).value).toBe('same-day');
    expect(field(/Window opens/).value).toBe('09:00');
    expect(field(/Window closes/).value).toBe('12:30');
    expect(field(/Order cut-off/).value).toBe('08:30');
    expect(screen.getByRole('button', { name: 'Remove delivery times' })).toBeTruthy();
  });

  it('offers the half hours of a day, and the end of the day only as a closing time', () => {
    mount();

    const options = (name: RegExp) => Array.from(field(name).options).map((option) => option.value);
    expect(options(/Window opens/)).toEqual([...CLOCK_TIMES]);
    expect(options(/Order cut-off/)).toEqual([...CLOCK_TIMES]);
    expect(options(/Window closes/)).toEqual([...CLOSE_TIMES]);
    expect(CLOCK_TIMES).toHaveLength(48);
    expect(CLOCK_TIMES.at(-1)).toBe('23:30');
    expect(CLOSE_TIMES.at(-1)).toBe('24:00');
    expect(CLOSE_TIMES).not.toContain('00:00');
  });

  it('saves with the version the screen read and the CSRF token, then shows the new version', async () => {
    call.mockResolvedValueOnce(ok(set())).mockResolvedValueOnce(ok({ version: 5, delivery: null }));
    mount();
    pick(/Orders placed before the cut-off arrive/, 'same-day');
    pick(/Window opens/, '09:00');
    pick(/Window closes/, '12:30');
    pick(/Order cut-off/, '08:30');

    save();

    await screen.findByText(/Delivery times saved/);
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/store-settings/delivery',
      { expectedVersion: 3, delivery: SET },
      'csrf',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove delivery times' }));
    await screen.findByText(/Delivery times removed/);
    // The next save names the version the last answer gave.
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'sellers/store-settings/delivery',
      { expectedVersion: 4, delivery: null },
      'csrf',
    );
  });

  it('does not send a window that closes before it opens, and says why next to the field', async () => {
    mount();
    pick(/Window opens/, '13:00');

    save();

    expect(await screen.findByText('The window must close after it opens.')).toBeTruthy();
    expect(screen.getByText('Check the times below and try again.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('does not send a same-day cut-off after the window closes, but allows it next day', async () => {
    mount();
    pick(/Orders placed before the cut-off arrive/, 'same-day');

    save();

    expect(
      await screen.findByText(
        'For same-day delivery the cut-off must be before the window closes.',
      ),
    ).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    call.mockResolvedValueOnce(ok(set()));
    pick(/Orders placed before the cut-off arrive/, 'next-day');
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });

  it('sends one write at a time while one is pending', async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    mount();

    save();
    save();
    finish(ok(set()));

    await screen.findByText(/Delivery times saved/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows the stale message with a reload button, and keeps what the seller typed', async () => {
    call.mockResolvedValueOnce(refused(409, 'conflict.stale'));
    mount();
    pick(/Order cut-off/, '10:00');

    save();

    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(field(/Order cut-off/).value).toBe('10:00');
  });

  it('is read-only without permission: fields disabled, no buttons', () => {
    mount(set(), false);

    expect(field(/Window opens/).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save delivery times' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove delivery times' })).toBeNull();
  });
});

describe('problemsOf', () => {
  const base = { day: 'next-day', from: '08:00', to: '12:00', cutoff: '14:00' } as const;

  it('finds nothing wrong with valid terms, including a window to the end of the day', () => {
    expect(problemsOf(base)).toEqual({});
    expect(problemsOf({ ...base, to: '24:00' })).toEqual({});
    expect(problemsOf({ ...base, day: 'same-day', cutoff: '11:30' })).toEqual({});
  });

  it('finds a window that is empty or backwards, and a same-day cut-off at or after the close', () => {
    expect(problemsOf({ ...base, from: '12:00' })).toHaveProperty(['delivery.to']);
    expect(problemsOf({ ...base, from: '13:00' })).toHaveProperty(['delivery.to']);
    expect(problemsOf({ ...base, day: 'same-day', cutoff: '12:00' })).toHaveProperty([
      'delivery.cutoff',
    ]);
    expect(problemsOf({ ...base, cutoff: '23:30' })).toEqual({});
  });
});

describe('problemOf', () => {
  it.each([
    [400, 'delivery.day', 'delivery.day'],
    [400, 'delivery.window', 'delivery.to'],
    [400, 'delivery.cutoff', 'delivery.cutoff'],
  ])('puts %i %s next to the field %s', (status, code, path) => {
    const problem = problemOf({ status, code });
    expect(Object.keys(problem.fields)).toEqual([path]);
    expect(problem.form).toBe('delivery.validation.summary');
  });

  it.each([
    [409, 'conflict.stale', 'delivery.error.stale'],
    [403, 'access.denied', 'delivery.error.denied'],
    [429, 'request.throttled', 'delivery.error.throttled'],
    [403, 'request.csrf', 'identity.error.request.csrf'],
    [503, 'sellers.unavailable', 'delivery.error.unavailable'],
    [0, 'network', 'delivery.error.unavailable'],
    [500, 'internal', 'identity.error.unknown'],
  ])('maps %i %s to the message %s', (status, code, key) => {
    expect(problemOf({ status, code }).form).toBe(key);
  });

  it('only uses message keys that exist', () => {
    const lookup = (key: string) =>
      key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);
    const keys = [
      'delivery.validation.summary',
      'delivery.validation.day',
      'delivery.validation.window',
      'delivery.validation.cutoff',
      'delivery.validation.cutoff-same-day',
      'delivery.error.stale',
      'delivery.error.denied',
      'delivery.error.throttled',
      'delivery.error.unavailable',
      'identity.error.request.csrf',
      'identity.error.unknown',
    ];
    for (const key of keys) expect([key, typeof lookup(key)]).toEqual([key, 'string']);
  });
});

describe('the Delivery settings tab', () => {
  it('shows only with the store settings permission', () => {
    const ids = (keys: string[]) => settingsTabs(keys, (key) => key).map((tab) => tab.id);
    expect(ids([])).not.toContain('delivery');
    expect(ids(['sellers.store-settings.edit'])).toContain('delivery');
  });
});
