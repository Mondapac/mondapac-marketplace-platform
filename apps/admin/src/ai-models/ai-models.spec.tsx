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
const USAGE = {
  from: '2026-10-28',
  to: '2026-11-26',
  days: 30,
  families: [
    {
      family: 'claude-haiku-5-5',
      provider: 'anthropic',
      calls: 1000,
      failures: 20,
      stoodIn: 3,
      costMicroUsd: 4_000_000,
      p95: { bound: 2000, above: false },
      evaluation: { passed: 1, of: 2 },
    },
    {
      family: 'claude-opus-5-5',
      provider: 'anthropic',
      calls: 0,
      failures: 0,
      stoodIn: 0,
      costMicroUsd: 0,
      p95: null,
      evaluation: { passed: 0, of: 2 },
    },
  ],
  tasks: [
    {
      task: 'chat',
      calls: 1000,
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      costByFamily: [
        { family: 'claude-haiku-5-5', costMicroUsd: 2_000_000 },
        { family: 'claude-sonnet-5-5', costMicroUsd: 6_000_000 },
        { family: 'claude-opus-5-5', costMicroUsd: null },
      ],
    },
  ],
};
/** The writes the page sent (the usage read on open is a GET). */
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(() => ok(USAGE));
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
    // A usable saved model is never listed as unknown (fixed in G5e).
    expect(screen.queryByText(/claude-haiku-5-5 \(Chat\)/)).toBeNull();
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
    expect(writes()).toEqual([]);
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
    expect(writes()).toEqual([]);
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

  it('shows the field problems of a refused save', async () => {
    call.mockImplementation(() =>
      Promise.resolve({
        ok: false as const,
        failure: {
          status: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'ai-models-chat.1', code: 'retired' }] },
        },
      }),
    );
    view();
    fireEvent.change(screen.getByLabelText('Add a model for Chat'), {
      target: { value: 'claude-sonnet-5-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Chat, model 2: Retired')).toBeTruthy();
  });

  it('keeps a saved saver that is no longer usable visible, and alerts on it', () => {
    view({
      initial: {
        ...ANSWER,
        settings: [
          row('ai-models-write', 'claude-haiku-5-5', 1),
          row('ai-saver-write', 'old-model', 1),
        ],
      },
    });
    expect(screen.getByRole('option', { name: 'old-model (Retired)' })).toBeTruthy();
    expect(screen.getByText(/old-model \(Write\): Retired/)).toBeTruthy();
  });

  it('drops the saver when it becomes the first model, and disables restore while edits are unsaved', () => {
    view({
      initial: {
        ...ANSWER,
        settings: [
          row('ai-models-chat', 'claude-haiku-5-5,claude-sonnet-5-5', 1),
          row('ai-saver-chat', 'claude-sonnet-5-5', 1),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move claude-sonnet-5-5 up' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Saver model for Chat').value).toBe('');
  });

  it('reads the usage once on open, with the view key path', async () => {
    view({ canManage: false });
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'settings/admin/ai-models/usage'));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('estimates the monthly cost change when a first model changes (G5e)', async () => {
    view();
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'settings/admin/ai-models/usage'));
    fireEvent.change(screen.getByLabelText('Add a model for Chat'), {
      target: { value: 'claude-sonnet-5-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move claude-sonnet-5-5 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText('Estimated monthly cost')).toBeTruthy();
    expect(
      screen.getByText('about US$4.00 more a month (US$2.00 to US$6.00 a month)', { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText(/Saver models and the threshold are not counted/)).toBeTruthy();
  });

  it('says when no first model changes, and when a model has no price here', async () => {
    view();
    await waitFor(() => expect(call).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Add a model for Chat'), {
      target: { value: 'claude-sonnet-5-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(
      await screen.findByText(
        'The first model of no task type changes, so the cost stays the same.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText('Add a model for Chat'), {
      target: { value: 'claude-opus-5-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move claude-opus-5-5 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move claude-opus-5-5 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(
      await screen.findByText(/Cannot be estimated: no usable route of the model here has a price/),
    ).toBeTruthy();
  });

  it('still lets the admin save when the usage cannot be read', async () => {
    call.mockImplementation((method: string) =>
      method === 'GET'
        ? Promise.resolve({ ok: false as const, failure: { status: 500, code: 'internal' } })
        : ok({ settings: [], options: {} }),
    );
    view();
    await waitFor(() => expect(call).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Remove claude-haiku-5-5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(await screen.findByText(/could not be read, so there is no estimate/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
  });

  it('shows the scorecard of the last 30 days on the Evaluation tab (G5e)', async () => {
    view();
    fireEvent.click(screen.getByRole('tab', { name: 'Evaluation' }));
    const table = await screen.findByRole('table', { name: 'Scorecard of the last 30 days' });
    const haiku = within(table).getByRole('row', { name: /claude-haiku-5-5/ });
    const cells = within(haiku)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells).toEqual(['1,000', 'US$4.00', '2.0%', '≤ 2 s', '3', '1 of 2 passed']);
    const opus = within(table).getByRole('row', { name: /claude-opus-5-5/ });
    expect(
      within(opus)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['0', '–', '–', '–', '0', '0 of 2 passed']);
    expect(screen.getByText(/from 2026-10-28 to 2026-11-26/)).toBeTruthy();
  });

  it('never keeps old numbers when a refresh fails', async () => {
    view();
    fireEvent.click(screen.getByRole('tab', { name: 'Evaluation' }));
    await screen.findByRole('table', { name: 'Scorecard of the last 30 days' });
    call.mockImplementation(() =>
      Promise.resolve({ ok: false as const, failure: { status: 500, code: 'internal' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh scorecard' }));
    expect(
      await screen.findByText('The scorecard could not be read. Try Refresh scorecard.'),
    ).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Scorecard of the last 30 days' })).toBeNull();
  });
});
