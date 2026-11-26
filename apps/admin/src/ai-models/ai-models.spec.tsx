// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { AiModelsPanel } from './ai-models-panel.tsx';
import { familiesOf, modelsAnswerOf, moved, valueOfFamilies, type ModelsAnswer } from './types.ts';

const call = vi.mocked(callApi);
const row = (code: string, value: string, version = 0) => ({
  code,
  value,
  version,
  updatedAt: null,
});
const option = (family: string, problem: string | null = null) => ({ family, problem });
const ANSWER: ModelsAnswer = {
  settings: [
    row('ai-models-chat', 'claude-haiku-5-5', 2),
    row('ai-models-write', 'old-model', 1),
    row('ai-saver-percent', '80'),
  ],
  options: {
    chat: [option('claude-haiku-5-5'), option('claude-sonnet-5-5'), option('claude-opus-5-5')],
    extract: [option('claude-haiku-5-5')],
    write: [option('claude-haiku-5-5'), option('old-model', 'retired')],
    vision: [],
  },
};

const view = (over: Partial<Parameters<typeof AiModelsPanel>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AiModelsPanel initial={ANSWER} canManage csrfToken="tok" {...over} />
    </NextIntlClientProvider>,
  );
const ok = (body: unknown) => Promise.resolve({ ok: true as const, status: 200, body });

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

describe('AI model helpers', () => {
  it('reads and writes the comma list', () => {
    expect(familiesOf('none')).toEqual([]);
    expect(familiesOf('a,b')).toEqual(['a', 'b']);
    expect(valueOfFamilies([])).toBe('none');
    expect(valueOfFamilies(['a', 'b'])).toBe('a,b');
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
  it('checks the answer it reads', () => {
    expect(
      modelsAnswerOf({ settings: [], options: { chat: [{ family: 'x', problem: null }] } }),
    ).not.toBeNull();
    expect(modelsAnswerOf({ settings: [] })).toBeNull();
  });
});

describe('Settings › AI Models', () => {
  it('warns about a saved model that can no longer be used', () => {
    view();
    expect(screen.getByText("Some chosen models can't be used now")).toBeTruthy();
    expect(screen.getByText(/old-model \(Write\): Retired/)).toBeTruthy();
  });

  it('offers only usable, unchosen models and no controls to a viewer', () => {
    view({ canManage: false });
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
    expect(screen.queryByLabelText('Add a model for Chat')).toBeNull();
  });

  it('adds a model, previews the change, then saves it with the version seen', async () => {
    call.mockImplementation(() => ok({ settings: [], options: {} }));
    view();
    const add = screen.getByLabelText('Add a model for Chat');
    const choices = within(add)
      .getAllByRole('option')
      .map((item) => item.textContent);
    expect(choices).toEqual(['Choose a model', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    fireEvent.change(add, { target: { value: 'claude-sonnet-5-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText('Save these changes?')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai-models',
        {
          changes: [
            {
              code: 'ai-models-chat',
              value: 'claude-haiku-5-5,claude-sonnet-5-5',
              expectedVersion: 2,
            },
          ],
        },
        'tok',
      ),
    );
  });

  it('refuses a threshold outside 50 to 99 without calling the API', () => {
    view();
    fireEvent.change(screen.getByLabelText('Saver threshold (%)'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(screen.getByText('Enter a whole number from 50 to 99.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('removing the only model drops its saver and saves none', async () => {
    call.mockImplementation(() => ok({ settings: [], options: {} }));
    view();
    fireEvent.click(screen.getByRole('button', { name: 'Remove claude-haiku-5-5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/ai-models',
        { changes: [{ code: 'ai-models-chat', value: 'none', expectedVersion: 2 }] },
        'tok',
      ),
    );
  });

  it('shows the own-model tab as not available yet', () => {
    view();
    fireEvent.click(screen.getByRole('tab', { name: 'Mondapac Intelligence' }));
    expect(screen.getByText(/Not available yet/)).toBeTruthy();
  });
});
