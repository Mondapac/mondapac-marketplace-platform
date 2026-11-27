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
import { InHousePanel } from './in-house-panel.tsx';
import {
  IN_HOUSE_CODES,
  inHouseAnswerOf,
  percentOfPermille,
  permilleOfPercent,
  valueOf,
  wholeWithin,
} from './in-house-types.ts';

const call = vi.mocked(callApi);
const row = (code: string, value: string, version = 0) => ({
  code,
  value,
  version,
  updatedAt: null,
});
const ok = (body: unknown) => Promise.resolve({ ok: true as const, status: 200, body });
const EMPTY = {
  settings: [],
  options: { chat: [], extract: [], write: [], vision: [] },
};
const WITH_MODEL = {
  settings: [
    row('ai-in-house-stage-write', 'percent', 3),
    row('ai-in-house-model-write', 'mondapac-1', 2),
    row('ai-in-house-rollout-write', '10', 1),
    row('ai-in-house-rollback-errors', '20', 4),
  ],
  options: {
    chat: [{ family: 'mondapac-1', problem: null }],
    extract: [],
    write: [
      { family: 'mondapac-1', problem: null },
      { family: 'mondapac-2', problem: null },
    ],
    vision: [],
  },
};
const RETIRED = {
  settings: [
    row('ai-in-house-stage-chat', 'default', 1),
    row('ai-in-house-model-chat', 'mondapac-0', 1),
  ],
  options: {
    chat: [{ family: 'mondapac-0', problem: 'retired' }],
    extract: [],
    write: [],
    vision: [],
  },
};

const view = (body: unknown, canManage = true) => {
  call.mockImplementation((method: string) => (method === 'GET' ? ok(body) : ok({ settings: [] })));
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <InHousePanel canManage={canManage} csrfToken="tok" />
    </NextIntlClientProvider>,
  );
};
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');

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

describe('in-house helpers', () => {
  it('converts rollback limits between percent and tenths of a percent', () => {
    expect(percentOfPermille('25')).toBe('2.5');
    expect(percentOfPermille('20')).toBe('2.0');
    expect(permilleOfPercent('2.5')).toBe('25');
    expect(permilleOfPercent('2,5')).toBe('25');
    expect(permilleOfPercent('5')).toBe('50');
    expect(permilleOfPercent('0.1')).toBe('1');
    expect(permilleOfPercent('5.1')).toBeNull();
    expect(permilleOfPercent('0')).toBeNull();
    expect(permilleOfPercent('1.25')).toBeNull();
    expect(permilleOfPercent('abc')).toBeNull();
  });
  it('takes whole numbers inside the bounds only', () => {
    expect(wholeWithin('10', 0, 99)).toBe('10');
    expect(wholeWithin('100', 0, 99)).toBeNull();
    expect(wholeWithin('1.5', 0, 99)).toBeNull();
    expect(wholeWithin('50', 100, 10_000)).toBeNull();
  });
  it('reads the answer and falls back to the defaults', () => {
    expect(inHouseAnswerOf(EMPTY)).not.toBeNull();
    expect(inHouseAnswerOf({ settings: [] })).toBeNull();
    expect(valueOf([], 'ai-in-house-stage-chat')).toBe('off');
    expect(valueOf([], 'ai-in-house-rollback-sample')).toBe('200');
    expect(IN_HOUSE_CODES).toHaveLength(19);
  });
});

describe('Mondapac Intelligence tab', () => {
  it('says no in-house model is connected and shows every stage off', async () => {
    view(EMPTY);
    expect(await screen.findByText('No in-house model is connected yet')).toBeTruthy();
    expect(screen.getAllByText('Stage in force:')).toHaveLength(4);
    expect(screen.getByLabelText<HTMLSelectElement>('Stage for Chat').value).toBe('off');
    expect(screen.getByLabelText<HTMLInputElement>('Error rate limit (%)').value).toBe('2.0');
    expect(call).toHaveBeenCalledWith('GET', 'settings/admin/ai-models/in-house');
  });

  it('previews and saves a stage change with the versions it saw', async () => {
    view(WITH_MODEL);
    const stage = await screen.findByLabelText<HTMLSelectElement>('Stage for Write');
    expect(stage.value).toBe('percent');
    expect(screen.getByLabelText<HTMLInputElement>('Percent share for Write (%)').value).toBe('10');
    fireEvent.change(screen.getByLabelText('Percent share for Write (%)'), {
      target: { value: '25' },
    });
    fireEvent.change(screen.getByLabelText('Error rate limit (%)'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Write percent share')).toBeTruthy();
    expect(within(dialog).getByText(/10% to 25%/)).toBeTruthy();
    expect(within(dialog).getByText(/2\.0% to 1\.5%/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'PUT',
      'settings/admin/ai-models/in-house',
      {
        changes: [
          { code: 'ai-in-house-rollout-write', value: '25', expectedVersion: 1 },
          { code: 'ai-in-house-rollback-errors', value: '15', expectedVersion: 4 },
        ],
      },
      'tok',
    ]);
  });

  it('shows the share field of the chosen stage only', async () => {
    view(WITH_MODEL);
    const stage = await screen.findByLabelText('Stage for Chat');
    expect(screen.queryByLabelText('Shadow share for Chat (%)')).toBeNull();
    fireEvent.change(stage, { target: { value: 'shadow' } });
    expect(screen.getByLabelText('Shadow share for Chat (%)')).toBeTruthy();
    expect(screen.queryByLabelText('Percent share for Chat (%)')).toBeNull();
  });

  it('sends nothing while a value is outside the bounds', async () => {
    view(WITH_MODEL);
    fireEvent.change(await screen.findByLabelText('Guard rejection limit (%)'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(
      await screen.findByText('Enter a number from 0.1 to 5.0, with at most one decimal.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('shows the field problems of a refused save', async () => {
    view(WITH_MODEL);
    fireEvent.change(await screen.findByLabelText('Stage for Chat'), {
      target: { value: 'shadow' },
    });
    call.mockImplementation((method: string) =>
      method === 'GET'
        ? ok(WITH_MODEL)
        : Promise.resolve({
            ok: false as const,
            failure: {
              status: 400,
              code: 'validation.failed',
              message: 'x',
              details: {
                fields: [{ path: 'ai-in-house-stage-chat', code: 'shadow-not-approved' }],
              },
            },
          }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save changes' }),
    );
    expect(
      await screen.findByText("Chat stage: Shadow isn't approved for this Market's data"),
    ).toBeTruthy();
    expect(
      screen.getByText("A choice isn't allowed. Check the stages, models, shares and limits."),
    ).toBeTruthy();
  });

  it('warns when a live stage keeps a model that can no longer be used', async () => {
    view(RETIRED);
    expect(await screen.findByText("Some chosen in-house models can't be used now")).toBeTruthy();
    expect(screen.getByText(/mondapac-0 \(Chat\): Retired/)).toBeTruthy();
  });

  it('is read only without the manage key', async () => {
    view(WITH_MODEL, false);
    expect(
      await screen.findByText('You can view these settings but not change them.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>('Stage for Write').disabled).toBe(true);
  });

  it('offers a retry when the settings cannot be read', async () => {
    call.mockImplementation(() => ok({ nope: true }));
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <InHousePanel canManage csrfToken="tok" />
      </NextIntlClientProvider>,
    );
    expect(
      await screen.findByText("Couldn't load the Mondapac Intelligence settings."),
    ).toBeTruthy();
    call.mockImplementation(() => ok(EMPTY));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No in-house model is connected yet')).toBeTruthy();
  });
});
