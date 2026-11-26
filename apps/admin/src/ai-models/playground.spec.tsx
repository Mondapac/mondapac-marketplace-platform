// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AiPlayground } from './playground.tsx';
import { playgroundAnswersOf, playgroundSuitesOf, usableFamilies } from './types.ts';

const call = vi.mocked(callApi);
const ok = (body: unknown) => Promise.resolve({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) =>
  Promise.resolve({ ok: false as const, failure: { status, code } });

const SAMPLES = {
  suites: [
    {
      capability: 'catalog.description-writer',
      setVersion: 'v1',
      samples: [
        { id: 's1', label: 'A tin of chickpeas' },
        { id: 's2', label: 'A jar of dates' },
      ],
    },
  ],
};
const ANSWERS = {
  answers: [
    {
      family: 'model-a',
      outcome: 'ok',
      text: '<b>Plain</b> text',
      checks: [],
      costMicroUsd: 1500,
      latencyMs: 820,
      route: 'primary',
    },
    {
      family: 'model-b',
      outcome: 'ok',
      text: 'Other text',
      checks: ['missing-fact'],
      costMicroUsd: 900,
      latencyMs: 640,
      route: 'primary',
    },
  ],
};

const view = (over: Partial<Parameters<typeof AiPlayground>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AiPlayground families={['model-a', 'model-b', 'model-c']} canRun csrfToken="tok" {...over} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  call.mockReset();
  call.mockImplementation((method) => (method === 'GET' ? ok(SAMPLES) : ok(ANSWERS)));
});
afterEach(cleanup);

async function pick() {
  await screen.findByLabelText('First model');
  fireEvent.change(screen.getByLabelText('First model'), { target: { value: 'model-a' } });
  fireEvent.change(screen.getByLabelText('Second model'), { target: { value: 'model-b' } });
}

describe('AI playground helpers', () => {
  it('checks what it reads', () => {
    expect(playgroundSuitesOf(SAMPLES)).toHaveLength(1);
    expect(playgroundSuitesOf({ suites: [{ capability: 1 }] })).toBeNull();
    expect(playgroundAnswersOf(ANSWERS)).toHaveLength(2);
    expect(playgroundAnswersOf({ answers: [{ family: 'x' }] })).toBeNull();
  });
  it('lists each usable family once', () => {
    const option = (family: string, problem: string | null = null) => ({ family, problem });
    expect(
      usableFamilies({
        settings: [],
        options: { chat: [option('a'), option('b', 'retired')], write: [option('a'), option('c')] },
      }),
    ).toEqual(['a', 'c']);
  });
});

describe('AI playground', () => {
  it('sends ids only and shows each answer as plain text', async () => {
    view();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Run on both models' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'settings/admin/ai-models/playground',
        {
          capability: 'catalog.description-writer',
          sampleId: 's1',
          families: ['model-a', 'model-b'],
        },
        'tok',
      ),
    );
    expect(await screen.findByText('<b>Plain</b> text')).toBeTruthy();
    expect(screen.getByText('Dropped a required fact')).toBeTruthy();
    expect(screen.getByText('$0.0015')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('does not offer the same model twice and keeps run disabled until both are chosen', async () => {
    view();
    await screen.findByLabelText('First model');
    const run = screen.getByRole<HTMLButtonElement>('button', { name: 'Run on both models' });
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('First model'), { target: { value: 'model-a' } });
    const second = screen.getByLabelText<HTMLSelectElement>('Second model');
    expect([...second.options].map((item) => item.value)).not.toContain('model-a');
  });

  it('lets a viewer look but not run', async () => {
    view({ canRun: false });
    await pick();
    expect(screen.getByText('You can look at the samples but not run them.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Run on both models' }).disabled,
    ).toBe(true);
  });

  it('says when the daily limit is used', async () => {
    call.mockImplementation((method) =>
      method === 'GET' ? ok(SAMPLES) : fail(429, 'ai.playground-limit-reached'),
    );
    view();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Run on both models' }));
    expect(await screen.findByText(/used today's 20 playground runs/)).toBeTruthy();
  });

  it('drops a slow answer once the admin has chosen something else', async () => {
    let finish: (value: never) => void = () => {};
    call.mockImplementation((method) =>
      method === 'GET' ? ok(SAMPLES) : new Promise((resolve) => (finish = resolve)),
    );
    view();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Run on both models' }));
    fireEvent.change(screen.getByLabelText('Sample'), { target: { value: 's2' } });
    await act(async () => {
      finish({ ok: true, status: 200, body: ANSWERS } as never);
      await Promise.resolve();
    });
    // The run answered after the choice changed: nothing of it may show.
    expect(screen.queryByText('Other text')).toBeNull();
    expect(screen.queryByText('Dropped a required fact')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run on both models' })).toBeTruthy();
  });

  it('never shows an answer with a failed check as a plain success', async () => {
    view();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Run on both models' }));
    expect(await screen.findByText('Answered, failed checks')).toBeTruthy();
    expect(screen.getAllByText('Answered')).toHaveLength(1);
  });

  it('shows a call that timed out or was refused, with no text', async () => {
    const empty = { text: null, checks: [], costMicroUsd: 0, latencyMs: null, route: null };
    call.mockImplementation((method) =>
      method === 'GET'
        ? ok(SAMPLES)
        : ok({
            answers: [
              { family: 'model-a', outcome: 'timeout', ...empty },
              { family: 'model-b', outcome: 'refused', ...empty },
            ],
          }),
    );
    view();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Run on both models' }));
    expect(await screen.findByText('Timed out')).toBeTruthy();
    expect(screen.getByText('Sample too large')).toBeTruthy();
    expect(screen.getAllByText('Nothing would be shown for this answer.')).toHaveLength(2);
    expect(screen.queryByText('Answered')).toBeNull();
  });

  it.each([
    ['access.acting-as-refused', 403, /can't be used while you are acting as a seller/],
    ['request.csrf', 403, /Your session expired/],
    ['access.denied', 403, /don't have permission to run the playground/],
  ])('explains a refusal %s', async (code, status, message) => {
    call.mockImplementation((method) => (method === 'GET' ? ok(SAMPLES) : fail(status, code)));
    view();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'Run on both models' }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it('shows a load failure', async () => {
    call.mockImplementation(() => fail(500, 'unknown'));
    view();
    expect(await screen.findByText("Couldn't load the playground samples.")).toBeTruthy();
  });
});
