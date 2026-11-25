import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  ADMIN_ID,
  answer,
  evalAdminContext,
  evaluationHarness,
} from '../../../../test/support/ai-evaluations';
import { AI_PLAYGROUND_RUNS_PER_ADMIN_DAY, EVALUATION_RUNS_PAGE } from './evaluation-control';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');

async function enqueue(
  harness: ReturnType<typeof evaluationHarness>,
  market: MarketContext,
  family = 'model-fast',
) {
  const estimate = await harness.control.estimate(
    testCallContext(market, 'system'),
    'anthropic',
    family,
  );
  const result = await harness.unitOfWork.run(market, async () =>
    ok(await harness.control.enqueue(market, estimate, ADMIN_ID)),
  );
  if (!result.ok) throw new Error('unit failed');
  return result.value;
}

describe('AiEvaluationControl (G4c; platform-ai.md section 8, Evaluation and Playground)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('lists every suite with its synthetic samples for the playground', () => {
    const { control } = evaluationHarness();
    expect(control.samples().map((suite) => suite.capability)).toEqual([
      'alpha.admin-writer',
      'alpha.seller-writer',
    ]);
    expect(control.samples()[0]!.samples.map((sample) => sample.id)).toEqual(['s-1', 's-2']);
  });

  describe('estimate', () => {
    it.each([AU, ZZ])(
      'sums a reservation per sample and reads the evaluation budget left (%s)',
      async (market) => {
        const { control } = evaluationHarness();
        const estimate = await control.estimate(
          evalAdminContext(market),
          'anthropic',
          'model-fast',
        );
        expect(estimate.capabilities.map((item) => [item.capability, item.samples])).toEqual([
          ['alpha.admin-writer', 2],
          ['alpha.seller-writer', 2],
        ]);
        expect(estimate.estimateMicroUsd).toBeGreaterThan(0);
        expect(estimate.estimateMicroUsd).toBe(
          estimate.capabilities.reduce((sum, item) => sum + item.estimateMicroUsd, 0),
        );
        expect(estimate.budgetLeftMicroUsd).toBe(10_000_000);
        expect(estimate.blockers).toEqual([]);
      },
    );

    it('names what blocks a run: an open run, no key, the close rule', async () => {
      const harness = evaluationHarness({
        keyed: ['AU'],
        budget: { evaluationMonthMicroUsd: 1_000, marketMonthMicroUsd: 0 },
      });
      await enqueue(harness, AU);
      const au = await harness.control.estimate(evalAdminContext(AU), 'anthropic', 'model-fast');
      expect(au.blockers).toEqual(['run-open', 'saver-closed']);
      const zz = await harness.control.estimate(evalAdminContext(ZZ), 'anthropic', 'model-fast');
      expect(zz.capabilities).toEqual([]);
      expect(zz.blockers).toContain('no-key');
    });
  });

  it('queues one open run per model and Market (a second is refused, another Market is not)', async () => {
    const harness = evaluationHarness();
    const first = await enqueue(harness, AU);
    expect(first).not.toBeNull();
    expect(await enqueue(harness, AU)).toBeNull();
    expect(await enqueue(harness, AU, 'model-balanced')).not.toBeNull();
    expect(await enqueue(harness, ZZ)).not.toBeNull();
  });

  it('cancels an open run of its Market only, marking pending capabilities incomplete', async () => {
    const harness = evaluationHarness();
    const runId = (await enqueue(harness, AU))!;
    expect(await harness.control.cancel(ZZ, runId)).toBe(false);
    expect(await harness.control.cancel(AU, runId)).toBe(true);
    expect(await harness.control.cancel(AU, runId)).toBe(false);
    const detail = await harness.control.detail(AU, runId);
    expect(detail?.run.status).toBe('cancelled');
    expect(detail?.capabilities.map((row) => row.verdict)).toEqual(['incomplete', 'incomplete']);
    expect(await harness.control.detail(ZZ, runId)).toBeNull();
  });

  it('pages the run list newest first with a cursor, and refuses a bad cursor or family', async () => {
    const harness = evaluationHarness();
    for (let index = 0; index < EVALUATION_RUNS_PAGE + 1; index += 1) {
      const runId = (await enqueue(harness, AU))!;
      await harness.control.cancel(AU, runId);
      harness.clock.advance(Temporal.Duration.from({ seconds: 1 }));
    }
    const first = await harness.control.list(AU, undefined, undefined);
    expect(first?.runs).toHaveLength(EVALUATION_RUNS_PAGE);
    expect(first?.next).not.toBeNull();
    const second = await harness.control.list(AU, undefined, first!.next!);
    expect(second?.runs).toHaveLength(1);
    expect(second?.next).toBeNull();
    expect(
      Temporal.Instant.compare(first!.runs[0]!.requestedAt, second!.runs[0]!.requestedAt),
    ).toBe(1);
    expect((await harness.control.list(ZZ, undefined, undefined))?.runs).toEqual([]);
    expect((await harness.control.list(AU, 'model-balanced', undefined))?.runs).toEqual([]);
    expect(await harness.control.list(AU, undefined, 'nope')).toBeNull();
    expect(await harness.control.list(AU, 'Bad Family', undefined)).toBeNull();
  });

  describe('playground', () => {
    it.each([AU, ZZ])(
      'runs one sample on two models in parallel and stores nothing (%s)',
      async (market) => {
        const harness = evaluationHarness();
        // Both calls must be in flight at once: each waits (at most 1 s) for the other.
        let arrived = 0;
        let both: () => void = () => undefined;
        const together = new Promise<void>((resolve) => (both = resolve));
        let parallel = false;
        harness.provider.answer = async () => {
          arrived += 1;
          if (arrived === 2) both();
          parallel = await Promise.race([
            together.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
          ]);
          return answer('<script>alert(1)</script>A rice pack, see https://x.example');
        };
        const result = await harness.control.playground(
          evalAdminContext(market),
          ADMIN_ID,
          'alpha.admin-writer',
          's-1',
          ['model-fast', 'model-balanced'],
        );
        expect(parallel).toBe(true);
        expect(result.kind).toBe('ran');
        if (result.kind !== 'ran') return;
        expect(result.answers.map((item) => [item.family, item.outcome])).toEqual([
          ['model-fast', 'ok'],
          ['model-balanced', 'ok'],
        ]);
        // The capability's guard output, plain text: no tag survives.
        expect(result.answers[0]!.text).not.toContain('<');
        expect(harness.store.runs.size).toBe(0);
        expect(harness.store.samples.size).toBe(0);
      },
    );

    it('answers a leaked claim with no text and the leak check', async () => {
      const harness = evaluationHarness();
      harness.provider.answer = () => Promise.resolve(answer('Certified halal rice'));
      const result = await harness.control.playground(
        evalAdminContext(AU),
        ADMIN_ID,
        'alpha.admin-writer',
        's-1',
        ['model-fast', 'model-balanced'],
      );
      expect(result).toMatchObject({
        kind: 'ran',
        answers: [
          { text: null, checks: ['leak'] },
          { text: null, checks: ['leak'] },
        ],
      });
    });

    it(`refuses the run after ${AI_PLAYGROUND_RUNS_PER_ADMIN_DAY} a Market day, per Market`, async () => {
      const harness = evaluationHarness();
      const play = (market: MarketContext) =>
        harness.control.playground(
          evalAdminContext(market),
          ADMIN_ID,
          'alpha.admin-writer',
          's-1',
          ['model-fast', 'model-balanced'],
        );
      for (let index = 0; index < AI_PLAYGROUND_RUNS_PER_ADMIN_DAY; index += 1) {
        expect((await play(AU)).kind).toBe('ran');
      }
      const calls = harness.provider.requests.length;
      expect(await play(AU)).toEqual({ kind: 'limit-reached' });
      expect(harness.provider.requests).toHaveLength(calls);
      expect((await play(ZZ)).kind).toBe('ran');
    });

    it.each([
      ['an unknown capability', 'alpha.tool-chat', 's-1', ['model-fast'], 'capability'],
      ['an unknown sample', 'alpha.admin-writer', 's-9', ['model-fast'], 'sampleId'],
      ['a family outside the catalogue', 'alpha.admin-writer', 's-1', ['model-x'], 'families.0'],
    ])('refuses %s before counting', async (_name, capability, sampleId, families, path) => {
      const harness = evaluationHarness();
      const result = await harness.control.playground(
        evalAdminContext(AU),
        ADMIN_ID,
        capability,
        sampleId,
        families,
      );
      expect(result).toMatchObject({ kind: 'invalid', path });
      expect(harness.store.playgroundDays.size).toBe(0);
      expect(harness.provider.requests).toHaveLength(0);
    });

    it('answers the close status per model when evaluations are closed', async () => {
      const harness = evaluationHarness({ budget: {} });
      expect(
        await harness.control.playground(
          evalAdminContext(AU),
          ADMIN_ID,
          'alpha.admin-writer',
          's-1',
          ['model-fast', 'model-balanced'],
        ),
      ).toMatchObject({
        kind: 'ran',
        answers: [{ outcome: 'closed-budget' }, { outcome: 'closed-budget' }],
      });
    });
  });
});
