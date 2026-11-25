import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  ADMIN_ID,
  FakeSuite,
  answer,
  evaluationHarness,
  type HarnessOptions,
} from '../../../../test/support/ai-evaluations';
import { ModelProviderError } from '../model-provider';
import type { JobContext } from '../../scheduler/job-registry';
import {
  AI_EVALUATION_RUNNER_JOB,
  EVALUATION_LEASE,
  aiEvaluationRunnerJob,
  verdictOf,
} from './evaluation-runner';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const job = (market: MarketContext) => testCallContext(market, 'system') as JobContext;
const SLOT = 295_000;

async function queued(harness: ReturnType<typeof evaluationHarness>, market: MarketContext) {
  const estimate = await harness.control.estimate(
    testCallContext(market, 'system'),
    'anthropic',
    'model-fast',
  );
  const result = await harness.unitOfWork.run(market, async () =>
    ok(await harness.control.enqueue(market, estimate, ADMIN_ID)),
  );
  if (!result.ok || result.value === null) throw new Error('not queued');
  return result.value;
}

function setUp(options: HarnessOptions = {}) {
  const harness = evaluationHarness(options);
  return harness;
}

describe('AiEvaluationRunner (G4c; platform-ai.md section 8, Evaluation)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing when the Market has no run to take', async () => {
    const { runner, provider } = setUp();
    expect(await runner.tick(job(AU), SLOT)).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });

  it.each([AU, ZZ])(
    'works every sample once and leaves pass candidates, never a pass (%s)',
    async (market) => {
      const harness = setUp();
      const runId = await queued(harness, market);
      expect(await harness.runner.tick(job(market), SLOT)).toEqual({ runId, stop: 'completed' });
      expect(harness.provider.requests).toHaveLength(4);
      expect((await harness.store.findRun(market, runId))?.status).toBe('completed');
      expect((await harness.store.capabilitiesOf(market, runId)).map((row) => row.verdict)).toEqual(
        ['pass-candidate', 'pass-candidate'],
      );
      const samples = await harness.store.samplesOf(market, runId);
      expect(samples).toHaveLength(4);
      expect(samples.every((sample) => sample.outcome === 'ok' && sample.checks.length === 0)).toBe(
        true,
      );
      // Codes and numbers only: no model text is kept.
      expect(JSON.stringify(samples)).not.toContain('pack');
      expect(harness.store.row(market, runId)?.leaseToken).toBeNull();
      // Another Market sees nothing of the run.
      const other = market === AU ? ZZ : AU;
      expect(await harness.store.findRun(other, runId)).toBeNull();
      expect(await harness.runner.tick(job(market), SLOT)).toBeNull();
    },
  );

  it('fails a capability on a leaked claim and leaves one with a failed call incomplete', async () => {
    const harness = setUp();
    let calls = 0;
    harness.provider.answer = () => {
      calls += 1;
      // seller-writer comes second (sorted): its first sample's call fails.
      if (calls === 1) return Promise.resolve(answer('Certified halal rice'));
      if (calls === 3) return Promise.reject(new ModelProviderError('server'));
      return Promise.resolve(answer('A fine rice and dates pack'));
    };
    const runId = await queued(harness, AU);
    await harness.runner.tick(job(AU), SLOT);
    const rows = await harness.store.capabilitiesOf(AU, runId);
    expect(rows.map((row) => [row.capability, row.verdict])).toEqual([
      ['alpha.admin-writer', 'failed'],
      ['alpha.seller-writer', 'incomplete'],
    ]);
    const samples = await harness.store.samplesOf(AU, runId);
    expect(samples[0]).toMatchObject({ sampleId: 's-1', outcome: 'ok', checks: ['leak'] });
  });

  it('hands the run back before a sample that could outlive the slot, and goes on later', async () => {
    const harness = setUp();
    const runId = await queued(harness, AU);
    harness.provider.answer = (request) => {
      harness.clock.advance(Temporal.Duration.from({ seconds: 2 }));
      const text = (request.messages[0]!.blocks[0] as { text: string }).text;
      return Promise.resolve(answer(text.includes('rice') ? 'rice' : 'dates'));
    };
    // Room for two samples of 1 s timeout each (2 s per call), not a third.
    expect(await harness.runner.tick(job(AU), 4_500)).toEqual({ runId, stop: 'paused' });
    expect(harness.provider.requests).toHaveLength(2);
    expect((await harness.store.findRun(AU, runId))?.status).toBe('running');
    expect(await harness.runner.tick(job(AU), SLOT)).toEqual({ runId, stop: 'completed' });
    expect(harness.provider.requests).toHaveLength(4);
    expect(await harness.store.samplesOf(AU, runId)).toHaveLength(4);
  });

  it('stops at the next sample when an admin cancelled the run', async () => {
    const harness = setUp();
    const runId = await queued(harness, AU);
    harness.provider.answer = async () => {
      await harness.store.cancel(AU, runId, harness.clock.now());
      return answer('rice');
    };
    expect(await harness.runner.tick(job(AU), SLOT)).toEqual({ runId, stop: 'ended' });
    expect(harness.provider.requests).toHaveLength(1);
    expect((await harness.store.findRun(AU, runId))?.status).toBe('cancelled');
  });

  it('stops when another job took the run after its lease ran out, and ends nothing', async () => {
    const harness = setUp();
    const runId = await queued(harness, AU);
    harness.provider.answer = async () => {
      harness.clock.advance(EVALUATION_LEASE.add({ seconds: 1 }));
      const now = harness.clock.now();
      await harness.store.claim(AU, runId, 'other-token', now, now.add(EVALUATION_LEASE));
      return answer('rice');
    };
    expect(await harness.runner.tick(job(AU), SLOT)).toEqual({ runId, stop: 'lost' });
    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.store.row(AU, runId)).toMatchObject({
      status: 'running',
      leaseToken: 'other-token',
    });
    // The first result was kept once; nothing is counted twice when the other job goes on.
    expect(await harness.store.samplesOf(AU, runId)).toHaveLength(1);
  });

  it('supersedes a capability whose evaluation set changed while the run waited', async () => {
    const admin = new FakeSuite('alpha.admin-writer');
    const harness = setUp({ suites: [admin, new FakeSuite('alpha.seller-writer')] });
    const runId = await queued(harness, AU);
    admin.setVersion = 'set-2';
    await harness.runner.tick(job(AU), SLOT);
    expect(
      (await harness.store.capabilitiesOf(AU, runId)).map((row) => [row.capability, row.verdict]),
    ).toEqual([
      ['alpha.admin-writer', 'superseded'],
      ['alpha.seller-writer', 'pass-candidate'],
    ]);
    expect(harness.provider.requests).toHaveLength(2);
  });

  it.each([
    ['the evaluation budget is full', { budget: {} }, () => undefined, 'closed-budget'],
    [
      'the emergency stop is on',
      {},
      (harness: ReturnType<typeof evaluationHarness>) => harness.controls.stopped.add('AU'),
      'closed-off',
    ],
  ] as const)(
    'ends the run when %s, every capability incomplete',
    async (_name, options, act, status) => {
      const harness = setUp(options);
      const runId = await queued(harness, AU);
      act(harness);
      expect(await harness.runner.tick(job(AU), SLOT)).toEqual({ runId, stop: status });
      expect(harness.provider.requests).toHaveLength(0);
      expect((await harness.store.findRun(AU, runId))?.status).toBe(status);
      expect((await harness.store.capabilitiesOf(AU, runId)).map((row) => row.verdict)).toEqual([
        'incomplete',
        'incomplete',
      ]);
    },
  );

  it('purges ended runs after 25 months and playground days after 90 Market days', async () => {
    const harness = setUp();
    const old = await queued(harness, AU);
    await harness.store.cancel(AU, old, harness.clock.now());
    await harness.store.takePlaygroundRun(AU, Temporal.PlainDate.from('2026-11-25'), ADMIN_ID, 20);
    harness.clock.advance(Temporal.Duration.from({ hours: 24 * 91 }));
    const open = await queued(harness, AU);
    expect(await harness.runner.purge(AU, 60_000)).toEqual({
      runs: 0,
      playgroundDays: 1,
      backlog: false,
    });
    harness.clock.set(Temporal.Instant.from('2029-01-01T00:00:00Z'));
    expect(await harness.runner.purge(AU, 60_000)).toEqual({
      runs: 1,
      playgroundDays: 0,
      backlog: false,
    });
    // An open run is never purged.
    expect(await harness.store.findRun(AU, open)).not.toBeNull();
  });

  it('is a job of every 15 s with a 300 s slot', async () => {
    const harness = setUp();
    const definition = aiEvaluationRunnerJob(harness.runner);
    expect(definition).toMatchObject({ name: AI_EVALUATION_RUNNER_JOB, maxRunMs: 300_000 });
    expect(definition.every.total({ unit: 'seconds' })).toBe(15);
    const runId = await queued(harness, ZZ);
    await definition.run(job(ZZ));
    expect((await harness.store.findRun(ZZ, runId))?.status).toBe('completed');
  });

  it('verdictOf: failed over incomplete over pass candidate', () => {
    const ok_ = { outcome: 'ok', checks: [] } as const;
    expect(verdictOf([ok_, ok_])).toBe('pass-candidate');
    expect(verdictOf([ok_, { outcome: 'timeout', checks: [] }])).toBe('incomplete');
    expect(
      verdictOf([
        { outcome: 'timeout', checks: [] },
        { outcome: 'ok', checks: ['leak'] },
      ]),
    ).toBe('failed');
  });
});
