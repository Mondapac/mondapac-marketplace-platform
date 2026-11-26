// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../step-up/step-up.tsx', async () => {
  const api = await import('../api/client.ts');
  return {
    useGuardedCall: () => api.callApi,
    isStepUpCancelled: (result: { ok: boolean; failure?: { code: string } }) =>
      !result.ok && result.failure?.code === 'step-up.cancelled',
  };
});

import { callApi } from '../api/client.ts';
import { AiGatewayPanel } from './ai-gateway-panel.tsx';
import {
  dollarsToMicro,
  historyOf,
  isComplete,
  microToDollars,
  raisesCap,
  settingsOf,
  type GatewaySetting,
} from './types.ts';

const call = vi.mocked(callApi);
const row = (code: string, value: string, version = 0): GatewaySetting => ({
  code,
  value,
  version,
  updatedAt: null,
});
const ROWS: readonly GatewaySetting[] = [
  row('ai-gateway-emergency-stop', 'off'),
  row('ai-cap-market-day', 'none'),
  row('ai-cap-buyer-chat-day', '10000000'),
  row('ai-cap-evaluation-month', '0'),
  row('ai-capability-assistant-buyer-chat', 'on'),
];

const view = (over: Partial<Parameters<typeof AiGatewayPanel>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AiGatewayPanel initial={ROWS} canManage csrfToken="tok" {...over} />
    </NextIntlClientProvider>,
  );
const ok = (body: unknown) => Promise.resolve({ ok: true as const, status: 200, body });

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('AI Gateway money', () => {
  it('converts micro-dollars and dollars both ways', () => {
    expect(microToDollars('10000000')).toBe('10');
    expect(microToDollars('500000')).toBe('0.5');
    expect(microToDollars('none')).toBe('none');
    expect(dollarsToMicro('0.5', true)).toBe('500000');
    expect(dollarsToMicro(' 10 ', true)).toBe('10000000');
    expect(dollarsToMicro('none', true)).toBe('none');
    expect(dollarsToMicro('none', false)).toBeNull();
    expect(dollarsToMicro('1.1234567', true)).toBeNull();
    expect(dollarsToMicro('1000001', true)).toBeNull();
    expect(dollarsToMicro('abc', true)).toBeNull();
  });
  it('knows when a change raises a cap', () => {
    expect(raisesCap('100', '200')).toBe(true);
    expect(raisesCap('100', 'none')).toBe(true);
    expect(raisesCap('none', '100')).toBe(false);
    expect(raisesCap('200', '100')).toBe(false);
  });
  it('treats an answer with a missing setting as incomplete', () => {
    expect(isComplete(ROWS)).toBe(false);
  });
  it('checks the answers it reads', () => {
    expect(settingsOf({ settings: [{ code: 'a', value: 'b', version: 1 }] })).toHaveLength(1);
    expect(settingsOf({ settings: [{ code: 'a' }] })).toBeNull();
    expect(historyOf({ history: [] })).toEqual([]);
    expect(historyOf({ nope: 1 })).toBeNull();
  });
});

describe('Settings › AI Gateway', () => {
  it('shows the stop off, the caps in dollars, and no button to a viewer', () => {
    view({ canManage: false });
    expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop all AI' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Buyer assistant chat, per day').value).toBe(
      '10',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Market, per day').value).toBe('none');
  });

  it('asks for a note before the emergency stop, then sends it with the version', async () => {
    call.mockImplementation(() => ok({ settings: [] }));
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Stop all AI' }));
    expect(await screen.findByText('Write a note first.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Note for this change'), {
      target: { value: 'Cost spike' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop all AI' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai-gateway/emergency-stop',
        { value: 'on', expectedVersion: 0, note: 'Cost spike' },
        'tok',
      ),
    );
  });

  it('sends only the changed caps, in micro-dollars', async () => {
    call.mockImplementation(() => ok({ settings: [] }));
    view();
    fireEvent.change(screen.getByLabelText('Market, per day'), { target: { value: '25.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai-gateway/limits',
        { changes: [{ code: 'ai-cap-market-day', value: '25500000', expectedVersion: 0 }] },
        'tok',
      ),
    );
  });

  it('refuses a bad cap on the field without calling the API, and none for evaluations', () => {
    view();
    fireEvent.change(screen.getByLabelText('Evaluations, per month'), {
      target: { value: 'none' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    expect(screen.getByText('Enter dollars such as 10 or 0.5, or none.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('switches a capability off without a note', async () => {
    call.mockImplementation(() => ok({ settings: [] }));
    view();
    fireEvent.click(screen.getByRole('switch', { name: 'Buyer assistant chat' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai-gateway/capabilities',
        {
          changes: [
            { code: 'ai-capability-assistant-buyer-chat', value: 'off', expectedVersion: 0 },
          ],
        },
        'tok',
      ),
    );
  });

  const entry = {
    code: 'ai-cap-market-day',
    version: 1,
    previousValue: null,
    value: '5000000',
    changedAt: '2026-11-26T01:00:00Z',
    changedBy: 'Sara',
    note: 'first',
    current: false,
  };
  const routed = (history: unknown) =>
    call.mockImplementation((method, path) =>
      method === 'GET' && path.includes('/history') ? ok(history) : ok({ settings: ROWS }),
    );

  it('lists the history and restores a version with the version in force', async () => {
    routed({ history: [entry, { ...entry, version: 2, value: 'none', current: true }] });
    view();
    fireEvent.change(screen.getByLabelText('Setting'), { target: { value: 'ai-cap-market-day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore version 1: US$5' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'settings/admin/ai-gateway/revert',
        { code: 'ai-cap-market-day', version: 1, expectedVersion: 0 },
        'tok',
      ),
    );
  });

  it('can restore the default from the oldest entry', async () => {
    routed({ history: [entry] });
    view();
    fireEvent.change(screen.getByLabelText('Setting'), { target: { value: 'ai-cap-market-day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore the default' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'settings/admin/ai-gateway/revert',
        { code: 'ai-cap-market-day', version: 0, expectedVersion: 0 },
        'tok',
      ),
    );
  });

  it('ignores a slow history answer for a setting the admin moved away from', async () => {
    let release: (value: { ok: true; status: number; body: unknown }) => void = () => undefined;
    call.mockImplementation((method, path) =>
      method === 'GET' && path.includes('ai-cap-market-day')
        ? new Promise((resolve) => {
            release = resolve;
          })
        : ok({ history: [] }),
    );
    view();
    fireEvent.change(screen.getByLabelText('Setting'), { target: { value: 'ai-cap-market-day' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    fireEvent.change(screen.getByLabelText('Setting'), { target: { value: 'ai-cap-guest-day' } });
    release({ ok: true, status: 200, body: { history: [entry] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /Restore version 1/ })).toBeNull();
  });

  it('asks for a note before restoring the emergency stop', async () => {
    routed({
      history: [{ ...entry, code: 'ai-gateway-emergency-stop', value: 'off', previousValue: 'on' }],
    });
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    fireEvent.click(await screen.findByRole('button', { name: /Restore version 1/ }));
    expect(await screen.findByText('Write a note first.')).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'POST')).toBe(false);
  });

  it('switches AI on again after the stop, with the note', async () => {
    call.mockImplementation(() => ok({ settings: ROWS }));
    view({ initial: [row('ai-gateway-emergency-stop', 'on', 3), ...ROWS.slice(1)] });
    expect(screen.getByText('All AI is stopped for this Market.')).toBeTruthy();
    expect(screen.getAllByText(/held off by the emergency stop/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Note for this change'), {
      target: { value: 'ok now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch AI on again' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai-gateway/emergency-stop',
        { value: 'off', expectedVersion: 3, note: 'ok now' },
        'tok',
      ),
    );
  });

  it('leaves the screen alone when the code dialog is cancelled', async () => {
    call.mockImplementation(() =>
      Promise.resolve({ ok: false as const, failure: { status: 0, code: 'step-up.cancelled' } }),
    );
    view();
    fireEvent.click(screen.getByRole('switch', { name: 'Buyer assistant chat' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reloads and says so on a conflict, and warns when the reload fails', async () => {
    call.mockImplementation((method) =>
      method === 'GET'
        ? Promise.resolve({ ok: false as const, failure: { status: 503, code: 'x' } })
        : Promise.resolve({
            ok: false as const,
            failure: { status: 409, code: 'settings.conflict' },
          }),
    );
    view();
    fireEvent.click(screen.getByRole('switch', { name: 'Buyer assistant chat' }));
    expect(
      await screen.findByText(/Saved, but the page couldn't refresh|couldn't refresh/),
    ).toBeTruthy();
  });
});
