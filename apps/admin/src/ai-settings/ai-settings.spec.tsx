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
import { expectToast } from '../../test/toast-spy.ts';
import { AiSettingsPanel } from './ai-settings-panel.tsx';
import { aiProblemOf } from './errors.ts';
import { modelSetupOf, settingOf, settingsAnswerOf, type AiSettingsAnswer } from './types.ts';

const call = vi.mocked(callApi);
const row = (code: string, value: string, version: number, updatedAt: string | null = null) => ({
  code,
  value,
  version,
  updatedAt,
});
const DEFAULTS: AiSettingsAnswer = {
  settings: [row('ai-description-writer', 'off', 0)],
};
const SETUP = { killSwitch: false, keyConfigured: true };

const view = (over: Partial<Parameters<typeof AiSettingsPanel>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AiSettingsPanel initial={DEFAULTS} setup={SETUP} canManage csrfToken="tok" {...over} />
    </NextIntlClientProvider>,
  );

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('Settings › AI', () => {
  it('shows the switch off and Key set, never a key, and no model tier picker (G4d1)', () => {
    view();
    expect(
      screen
        .getByRole('switch', { name: 'Write with AI (product descriptions)' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/Model tier|Fast model|Balanced model/)).toBeNull();
    expect(screen.getByText('Key set')).toBeTruthy();
    expect(screen.queryByText('No key')).toBeNull();
  });

  it('says No key when the server has none', () => {
    view({ setup: { killSwitch: false, keyConfigured: false } });
    expect(screen.getByText('No key')).toBeTruthy();
  });

  it('ignores a stored tier row the API may still send', () => {
    view({
      initial: {
        settings: [
          row('ai-description-writer', 'on', 2),
          row('ai-description-writer-tier', 'fast', 3),
        ],
      },
    });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows a notice when the kill switch is set', () => {
    view({ setup: { ...SETUP, killSwitch: true } });
    expect(screen.getByText('AI is switched off for the whole platform.')).toBeTruthy();
  });

  it('says the setup could not be read, and still shows the switch', () => {
    view({ setup: null });
    expect(screen.getByText('The server setup could not be read.')).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('turns the switch on with the version it saw and shows the answer', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: row('ai-description-writer', 'on', 1, '2026-11-13T00:00:00Z'),
    });
    view();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'settings/admin/ai',
      { code: 'ai-description-writer', value: 'on', expectedVersion: 0 },
      'tok',
    );
    expect(screen.getByText(/Last changed/)).toBeTruthy();
  });

  describe('where a change is reviewed', () => {
    const review = { reviewed: true, risk: 'medium' };
    const REVIEWED: AiSettingsAnswer = {
      settings: [{ ...row('ai-description-writer', 'off', 0), review }],
    };

    it('asks for no note when the view does not say reviewed', () => {
      view();
      expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    });

    it('does not save without a note', () => {
      view({ initial: REVIEWED });
      fireEvent.click(screen.getByRole('switch'));
      expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
      expect(call).not.toHaveBeenCalled();
    });

    it('sends the note with the change and says it was sent for review', async () => {
      call.mockResolvedValue({
        ok: true,
        status: 200,
        body: {
          ...row('ai-description-writer', 'on', 1),
          review,
          request: { id: 'r1', number: 5 },
        },
      });
      view({ initial: REVIEWED });
      fireEvent.change(screen.getByLabelText('Note for reviewers'), {
        target: { value: 'Pilot with sellers' },
      });
      fireEvent.click(screen.getByRole('switch'));
      await expectToast('Sent for review (SR-5)', 'info');
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai',
        {
          code: 'ai-description-writer',
          value: 'on',
          expectedVersion: 0,
          note: 'Pilot with sellers',
        },
        'tok',
      );
    });

    it('shows a 400 on note on the note field', async () => {
      call.mockResolvedValue({
        ok: false,
        failure: {
          status: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'note', code: 'required' }] },
        },
      });
      view({ initial: REVIEWED });
      fireEvent.change(screen.getByLabelText('Note for reviewers'), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('switch'));
      expect(await screen.findByText(/The note was refused/)).toBeTruthy();
    });
  });

  it('on a version conflict says so and shows what is saved now', async () => {
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'PUT'
          ? { ok: false, failure: { status: 409, code: 'settings.conflict' } }
          : {
              ok: true,
              status: 200,
              body: {
                settings: [row('ai-description-writer', 'on', 5)],
              },
            },
      ),
    );
    view();
    fireEvent.click(screen.getByRole('switch'));
    const notice = await screen.findByText('Someone else changed this. The values were reloaded.');
    // A conflict is announced politely, not as an alert.
    expect(notice.closest('[role]')?.getAttribute('role')).toBe('status');
    await waitFor(() =>
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
    expect(call).toHaveBeenLastCalledWith('GET', 'settings/admin/ai');
  });

  it('sends the user to sign-in when the reload after a conflict answers 401', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'PUT'
          ? { ok: false, failure: { status: 409, code: 'settings.conflict' } }
          : { ok: false, failure: { status: 401, code: 'session.invalid' } },
      ),
    );
    view();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows a refusal and leaves the switch alone', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    view();
    fireEvent.click(screen.getByRole('switch'));
    expect(
      await screen.findByText("You don't have permission to change this setting."),
    ).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('is read-only without the manage key', () => {
    view({ canManage: false });
    expect(screen.getByRole<HTMLButtonElement>('switch').disabled).toBe(true);
    expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
  });

  it('does nothing and shows nothing when the code dialog is cancelled', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: 'step-up.cancelled' } });
    view();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });
});

describe('switching Write with AI on (G4d3)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('says the two-step code is needed when the server still asks for one, and stays off', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 403,
        code: 'second-factor.enrolment-required',
        details: { actionKey: 'settings.ai-capability.resume' },
      },
    });
    view();
    fireEvent.click(screen.getByRole('switch'));
    expect(
      await screen.findByText(
        'Switching Write with AI on needs your two-step code. Try again and enter the code.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(aiProblemOf({ status: 403, code: 'second-factor.required' })).toBe('second-factor');
  });
});

describe('answers and refusals', () => {
  it('falls back to off when the API names no row', () => {
    expect(settingOf({ settings: [] }, 'ai-description-writer').value).toBe('off');
  });

  it('checks the answers', () => {
    expect(settingsAnswerOf({ settings: [row('a', 'b', 1)] })?.settings).toHaveLength(1);
    expect(settingsAnswerOf({ settings: [{ code: 'a' }] })).toBeNull();
    expect(settingsAnswerOf(null)).toBeNull();
    expect(modelSetupOf(SETUP)).toEqual(SETUP);
    // An older server's models are dropped, never shown.
    expect(modelSetupOf({ ...SETUP, models: { fast: 'm-fast', balanced: null } })).toEqual(SETUP);
    expect(modelSetupOf({ killSwitch: 'no' })).toBeNull();
  });

  it('words refusals', () => {
    expect(aiProblemOf({ status: 409, code: 'settings.conflict' })).toBe('conflict');
    expect(aiProblemOf({ status: 429, code: 'x' })).toBe('throttled');
    expect(aiProblemOf({ status: 503, code: 'x' })).toBe('unavailable');
    expect(aiProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
