// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { centsOf, dollarsOf, formOf, refusedFields, settingsOf } from './assistant-form.ts';
import { AssistantSettingsPanel } from './assistant-settings-panel.tsx';
import type { AssistantSettings, AssistantSettingsAnswer } from './assistant-types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const DEFAULTS: AssistantSettings = {
  enabled: false,
  audience: 'internal',
  audiencePercent: null,
  scope: 'read-only',
  modelTier: 'fast',
  users: 'guests-and-customers',
  guestMessageLimit: 20,
  customerMessageLimit: 40,
  retention: '30-days',
  replyLanguage: 'buyer',
  dailySpendCapUsdCents: 1_000,
  monthlySpendCapUsdCents: 20_000,
  supportHandoff: 'email-link',
  welcomeText: null,
};
const UNAVAILABLE = { scope: ['cart-suggestions'], supportHandoff: ['in-panel-form'] } as const;

const answer = (
  settings: Partial<AssistantSettings> = {},
  more: Partial<AssistantSettingsAnswer> = {},
): AssistantSettingsAnswer => ({
  version: 0,
  settings: { ...DEFAULTS, ...settings },
  apiKey: 'not-set',
  models: [
    { tier: 'fast', modelId: 'model-fast-test' },
    { tier: 'balanced', modelId: null },
  ],
  unavailableOptions: UNAVAILABLE,
  ...more,
});

const mount = (initial: AssistantSettingsAnswer, canManage = true) =>
  render(wrap(<AssistantSettingsPanel initial={initial} canManage={canManage} csrfToken="csrf" />));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AssistantSettingsPanel', () => {
  it('shows the shipped defaults: off, internal only, read-only answers', () => {
    mount(answer());
    expect(screen.getByLabelText<HTMLInputElement>('Assistant switched on').checked).toBe(false);
    expect(screen.getByLabelText<HTMLSelectElement>('Show to').value).toBe('internal');
    expect(screen.getByLabelText<HTMLSelectElement>('What it can do').value).toBe('read-only');
    expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe('fast');
    expect(screen.getByLabelText<HTMLInputElement>('Messages per guest').value).toBe('20');
    expect(screen.getByLabelText<HTMLInputElement>('Daily cap').value).toBe('10');
    expect(screen.getByLabelText<HTMLInputElement>('Monthly cap').value).toBe('200');
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('shows the key only as set or not set, and offers unavailable options disabled', () => {
    mount(answer());
    expect(screen.getByText('Not set')).toBeTruthy();
    const cart = screen.getByRole<HTMLOptionElement>('option', {
      name: 'Answer and suggest cart actions (not available yet)',
    });
    expect(cart.disabled).toBe(true);
    const form = screen.getByRole<HTMLOptionElement>('option', {
      name: 'Form inside the chat window (not available yet)',
    });
    expect(form.disabled).toBe(true);
  });

  it('warns when switched on without a key or model', () => {
    mount(answer({ enabled: true }));
    expect(screen.getByText(/buyers do not see it yet/)).toBeTruthy();
    cleanup();
    mount(answer({ enabled: true }, { apiKey: 'set' }));
    expect(screen.queryByText(/buyers do not see it yet/)).toBeNull();
  });

  it('shows a read-only summary without the manage permission', () => {
    mount(answer({ audience: 'percent', audiencePercent: 25 }), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      screen.getByText('Only the Platform Administrator can change these settings.'),
    ).toBeTruthy();
    expect(screen.getByText('25% of visitors')).toBeTruthy();
    expect(screen.getByText("The storefront's default text")).toBeTruthy();
  });

  it('saves every field with the version it read', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: answer({ enabled: true, audience: 'percent', audiencePercent: 10 }, { version: 1 }),
    });
    mount(answer());
    fireEvent.click(screen.getByLabelText('Assistant switched on'));
    fireEvent.change(screen.getByLabelText('Show to'), { target: { value: 'percent' } });
    fireEvent.change(screen.getByLabelText('Share of visitors (%)'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Daily cap'), { target: { value: '12.5' } });
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'assistant/admin/settings',
      {
        expectedVersion: 0,
        settings: {
          ...DEFAULTS,
          enabled: true,
          audience: 'percent',
          audiencePercent: 10,
          dailySpendCapUsdCents: 1_250,
        },
      },
      'csrf',
    );
    expect(await screen.findByText(/Settings saved/)).toBeTruthy();
    expect(screen.getByText('Version 1')).toBeTruthy();
  });

  it('names bad fields before calling the API', () => {
    mount(answer());
    fireEvent.change(screen.getByLabelText('Messages per guest'), { target: { value: '61' } });
    fireEvent.change(screen.getByLabelText('Daily cap'), { target: { value: '300' } });
    save();
    expect(screen.getByText('Enter a whole number from 5 to 60.')).toBeTruthy();
    expect(
      screen.getByText(/no more than the monthly cap/, { selector: 'p[id$="-error"]' }),
    ).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('re-reads the settings after a conflict and says so', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'assistant.conflict' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: answer({ guestMessageLimit: 30 }, { version: 4 }),
      });
    mount(answer());
    save();
    expect(
      await screen.findByText(/Another admin saved changes first. The page now shows/),
    ).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', 'assistant/admin/settings');
    expect(screen.getByLabelText<HTMLInputElement>('Messages per guest').value).toBe('30');
    expect(screen.getByText('Version 4')).toBeTruthy();
  });

  it('marks the fields the API refused', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'welcomeText', code: 'format' }] },
      },
    });
    mount(answer());
    save();
    expect(await screen.findByText(/without < or >/)).toBeTruthy();
    expect(
      screen.getByText('Some settings were refused. Check the fields and try again.'),
    ).toBeTruthy();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount(answer());
    save();
    expect(
      await screen.findByText('Your role cannot change the smart assistant settings.'),
    ).toBeTruthy();
  });
});

describe('assistant form', () => {
  it('converts dollars and cents without float error', () => {
    expect(centsOf('10')).toBe(1_000);
    expect(centsOf('0.29')).toBe(29);
    expect(centsOf('12.5')).toBe(1_250);
    expect(centsOf('1.234')).toBeNull();
    expect(centsOf('-1')).toBeNull();
    expect(centsOf('1e3')).toBeNull();
    expect(dollarsOf(1_250)).toBe('12.50');
    expect(dollarsOf(20_000)).toBe('200');
  });

  it('sends null for an empty welcome text and refuses markup or hidden characters', () => {
    const base = formOf(DEFAULTS);
    const empty = settingsOf({ ...base, welcomeText: '   ' }, UNAVAILABLE);
    expect(empty.ok && empty.settings.welcomeText).toBeNull();
    for (const bad of ['<b>hi</b>', 'a‮b', 'x'.repeat(201)]) {
      const check = settingsOf({ ...base, welcomeText: bad }, UNAVAILABLE);
      expect(check.ok ? [] : check.invalid).toEqual(['welcomeText']);
    }
    const persian = settingsOf({ ...base, welcomeText: 'می‌توانم کمک کنم' }, UNAVAILABLE);
    expect(persian.ok).toBe(true);
  });

  it('refuses an option that is not available yet and keeps the percent only for percent', () => {
    const base = formOf(DEFAULTS);
    const cart = settingsOf({ ...base, scope: 'cart-suggestions' }, UNAVAILABLE);
    expect(cart.ok ? [] : cart.invalid).toEqual(['scope']);
    const all = settingsOf({ ...base, audience: 'all', audiencePercent: '50' }, UNAVAILABLE);
    expect(all.ok && all.settings.audiencePercent).toBeNull();
  });

  it('keeps only the refused fields the form shows', () => {
    expect(
      refusedFields({
        status: 400,
        code: 'validation.failed',
        details: {
          fields: [
            { path: 'guestMessageLimit', code: 'range' },
            { path: 'other', code: 'unknown-field' },
          ],
        },
      }),
    ).toEqual(['guestMessageLimit']);
  });
});
