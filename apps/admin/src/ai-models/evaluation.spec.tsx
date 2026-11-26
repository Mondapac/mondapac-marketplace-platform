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
import { EvaluationPanel } from './evaluation-panel.tsx';
import { detailOf, dollars, estimateOf, familiesOfOptions, runListOf } from './evaluation-types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000a1';
const RUN = {
  id: ID,
  provider: 'anthropic',
  family: 'claude-sonnet-5-5',
  status: 'running',
  requestedBy: 'x',
  requestedAt: '2026-11-26T01:00:00Z',
  estimateMicroUsd: 1_500_000,
  startedAt: null,
  endedAt: null,
};
const ESTIMATE = {
  provider: 'anthropic',
  family: 'claude-opus-5-5',
  capabilities: [
    {
      capability: 'description-writer',
      promptVersion: 'p1',
      setVersion: 's1',
      samples: 12,
      estimateMicroUsd: 2_000_000,
    },
  ],
  estimateMicroUsd: 2_000_000,
  budgetLeftMicroUsd: 10_000_000,
  blockers: [],
};
const DETAIL = {
  run: RUN,
  capabilities: [
    {
      capability: 'description-writer',
      promptVersion: 'p1',
      setVersion: 's1',
      samplesTotal: 12,
      verdict: 'pass-candidate',
    },
  ],
  samples: [
    {
      capability: 'description-writer',
      sampleId: 'sample-1',
      outcome: 'ok',
      checks: ['too-long'],
      callId: null,
      route: 'direct',
      attempt: 1,
      inputTokens: 100,
      outputTokens: 50,
      costMicroUsd: 1200,
      latencyMs: 800,
      finishedAt: '2026-11-26T01:01:00Z',
    },
  ],
  costMicroUsd: 1200,
};

const ok = (body: unknown) => Promise.resolve({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, fields?: { path: string; code: string }[]) =>
  Promise.resolve({
    ok: false as const,
    failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
  });

/** Answers each route by its path; `over` replaces one. */
function routes(over: Record<string, () => Promise<unknown>> = {}) {
  call.mockImplementation(((method: string, path: string) => {
    const key = `${method} ${path.split('?')[0]}`;
    const table: Record<string, () => Promise<unknown>> = {
      'GET settings/admin/ai-models/evaluations': () => ok({ runs: [RUN], next: null }),
      'GET settings/admin/ai-models/evaluations/estimate': () => ok(ESTIMATE),
      [`GET settings/admin/ai-models/evaluations/${ID}`]: () => ok(DETAIL),
      ...over,
    };
    return (table[key] ?? (() => fail(404, 'not-found')))();
  }) as never);
}

const view = (over: Partial<Parameters<typeof EvaluationPanel>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EvaluationPanel
        families={['claude-opus-5-5', 'claude-sonnet-5-5']}
        canManage
        csrfToken="tok"
        {...over}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  call.mockReset();
});
afterEach(cleanup);

describe('evaluation readers', () => {
  it('read what the API answers and refuse a malformed answer', () => {
    expect(runListOf({ runs: [RUN], next: null })?.runs).toHaveLength(1);
    expect(runListOf({ runs: [{ id: 1 }], next: null })).toBeNull();
    expect(estimateOf(ESTIMATE)?.estimateMicroUsd).toBe(2_000_000);
    expect(estimateOf({ ...ESTIMATE, blockers: 'run-open' })).toBeNull();
    expect(detailOf(DETAIL)?.samples[0]?.sampleId).toBe('sample-1');
    expect(detailOf({ ...DETAIL, samples: [{}] })).toBeNull();
    expect(dollars(1_500_000)).toBe('1.5');
    expect(
      familiesOfOptions({ chat: [{ family: 'b' }, { family: 'a' }], write: [{ family: 'a' }] }),
    ).toEqual(['a', 'b']);
  });
});

describe('Settings › AI Models › Evaluation', () => {
  it('lists the runs, and states that a result is only a pass candidate', async () => {
    routes();
    view();
    expect(await screen.findByText('Running')).toBeTruthy();
    expect(screen.getByText(/only a pass candidate/)).toBeTruthy();
  });

  it('shows the estimate first, then starts the run with the amount confirmed', async () => {
    routes({ 'POST settings/admin/ai-models/evaluations': () => ok({ runId: ID }) });
    view();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    expect(await screen.findByText('US$2')).toBeTruthy();
    expect(screen.getByText(/US\$10 left/)).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'settings/admin/ai-models/evaluations',
        { provider: 'anthropic', family: 'claude-opus-5-5', expectedEstimateMicroUsd: 2_000_000 },
        'tok',
      ),
    );
    expect(await screen.findByText(/queued/)).toBeTruthy();
  });

  it('does not offer the run while something blocks it, and gives no controls to a viewer', async () => {
    routes({
      'GET settings/admin/ai-models/evaluations/estimate': () =>
        ok({ ...ESTIMATE, blockers: ['run-open'] }),
    });
    view();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    expect(await screen.findByText('This model already has a run in progress')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run evaluation' }).disabled).toBe(
      true,
    );
    cleanup();
    routes();
    view({ canManage: false });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    await screen.findByText('US$2');
    expect(screen.queryByRole('button', { name: 'Run evaluation' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
  });

  it('reads the estimate again when the server says it went stale', async () => {
    routes({
      'POST settings/admin/ai-models/evaluations': () =>
        fail(400, 'validation.failed', [{ path: 'expectedEstimateMicroUsd', code: 'stale' }]),
    });
    view();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    await screen.findByText('US$2');
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    expect(await screen.findByText(/The estimate changed/)).toBeTruthy();
    const estimates = call.mock.calls.filter(([, path]) => String(path).includes('/estimate?'));
    expect(estimates).toHaveLength(2);
  });

  it('names each blocker of a refused run', async () => {
    routes({
      'POST settings/admin/ai-models/evaluations': () =>
        fail(400, 'validation.failed', [{ path: 'family', code: 'no-key' }]),
    });
    view();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    await screen.findByText('US$2');
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    expect(await screen.findByText('No key set')).toBeTruthy();
  });

  it('stays quiet when the two-step code is cancelled', async () => {
    routes({ 'POST settings/admin/ai-models/evaluations': () => fail(0, 'step-up.cancelled') });
    view();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-opus-5-5' } });
    await screen.findByText('US$2');
    fireEvent.click(screen.getByRole('button', { name: 'Run evaluation' }));
    await waitFor(() => expect(call.mock.calls.some(([method]) => method === 'POST')).toBe(true));
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.queryByText(/queued/)).toBeNull();
  });

  it('cancels an open run without a code and reads the list again', async () => {
    routes({ [`POST settings/admin/ai-models/evaluations/${ID}/cancel`]: () => ok({ runId: ID }) });
    view();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel the claude-sonnet-5-5 run' }),
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `settings/admin/ai-models/evaluations/${ID}/cancel`,
        undefined,
        'tok',
      ),
    );
    await waitFor(() =>
      expect(
        call.mock.calls.filter(
          ([method, path]) => method === 'GET' && path === 'settings/admin/ai-models/evaluations',
        ),
      ).toHaveLength(2),
    );
  });

  it('does not let a failed reload after a cancel look current', async () => {
    let reads = 0;
    routes({
      'GET settings/admin/ai-models/evaluations': () =>
        reads++ === 0 ? ok({ runs: [RUN], next: null }) : fail(503, 'access.unavailable'),
      [`POST settings/admin/ai-models/evaluations/${ID}/cancel`]: () => ok({ runId: ID }),
    });
    view();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel the claude-sonnet-5-5 run' }),
    );
    expect(await screen.findByText(/couldn't refresh/)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Cancel the claude-sonnet-5-5 run',
      }).disabled,
    ).toBe(true);
  });

  it('shows a run with its verdicts and sample outcomes, numbers only', async () => {
    routes();
    view();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Details of the claude-sonnet-5-5 run' }),
    );
    expect(await screen.findByText('Pass candidate')).toBeTruthy();
    expect(screen.getByText('sample-1')).toBeTruthy();
    expect(screen.getByText('Too long')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
  });

  it('asks for the next page of runs with its cursor and the model filter', async () => {
    routes({
      'GET settings/admin/ai-models/evaluations': () => ok({ runs: [RUN], next: '1.abc' }),
    });
    view();
    fireEvent.change(screen.getByLabelText('Show runs of'), {
      target: { value: 'claude-sonnet-5-5' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Show older runs' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'GET',
        'settings/admin/ai-models/evaluations?family=claude-sonnet-5-5&cursor=1.abc',
      ),
    );
  });
});
