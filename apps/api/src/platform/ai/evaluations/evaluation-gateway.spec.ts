import { Logger } from '@nestjs/common';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  EVAL_SPECS,
  FakeSuite,
  answer,
  evalAdminContext,
  evalSellerContext,
  evaluationHarness,
} from '../../../../test/support/ai-evaluations';
import { testRoute } from '../../../../test/support/ai-routes';
import { MASKED } from '../personal-data-masker';
import { ModelProviderError } from '../model-provider';
import { AI_EVALUATION_USAGE } from '../usage/ai-usage';
import { closedBySaverThreshold } from './evaluation-gateway';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const WRITER = EVAL_SPECS.find((spec) => spec.id === 'alpha.admin-writer')!;

describe('AI evaluation gateway (G4c; platform-ai.md section 8, Evaluation and Playground)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('AiRouter.evaluationPlan (ADR-0052 decision 3, the one exception)', () => {
    it.each([AU, ZZ])('pins one family of one provider, without a pass, in %s', (market) => {
      const { router } = evaluationHarness();
      const plan = router.evaluationPlan(market.marketId, WRITER, 'anthropic', 'model-balanced');
      expect(plan.map((route) => route.row.id)).toEqual(['anthropic-api/model-balanced']);
      // `plan` and `routeProblem` still refuse the same row: it has no recorded pass.
      expect(router.routeProblem(market.marketId, WRITER, plan[0]!.row)).toBe('not-evaluated');
      expect(router.evaluationPlan(market.marketId, WRITER, 'other', 'model-balanced')).toEqual([]);
    });

    it('drops rows without a key, unchecked, out of the region or retired', () => {
      const { router } = evaluationHarness({
        keyed: ['AU'],
        extraRoutes: [
          testRoute('model-unchecked', 'anthropic-api', { dataTerms: null }),
          testRoute('model-far', 'anthropic-api', { region: 'us-east-1' }),
          testRoute('model-old', 'anthropic-api', { retiresOn: '2026-01-01' }),
        ],
      });
      // The Bedrock row of model-fast has no key: the API row alone.
      expect(
        router
          .evaluationPlan('AU' as never, WRITER, 'anthropic', 'model-fast')
          .map((r) => r.row.id),
      ).toEqual(['anthropic-api/model-fast']);
      for (const [family, problem] of [
        ['model-unchecked', 'not-checked'],
        ['model-far', 'region'],
        ['model-old', 'retired'],
        ['model-none', 'unknown-model'],
      ] as const) {
        expect(router.evaluationPlan('AU' as never, WRITER, 'anthropic', family)).toEqual([]);
        expect(router.evaluationProblem('AU' as never, WRITER, 'anthropic', family)).toBe(problem);
      }
      expect(router.evaluationPlan('ZZ' as never, WRITER, 'anthropic', 'model-fast')).toEqual([]);
      expect(router.evaluationProblem('ZZ' as never, WRITER, 'anthropic', 'model-fast')).toBe(
        'no-key',
      );
    });
  });

  describe('run', () => {
    it.each([AU, ZZ])(
      'runs a sample masked, without tools, held to the output cap, on the evaluation budget only (%s)',
      async (market) => {
        const { gateway, provider, usageStore } = evaluationHarness();
        const result = await gateway.run(
          'alpha.admin-writer',
          's-1',
          'anthropic',
          'model-fast',
          testCallContext(market, 'system'),
        );
        expect(result).toMatchObject({ kind: 'done', outcome: 'ok', costMicroUsd: 200 });
        expect(provider.requests).toHaveLength(1);
        const [sent] = provider.requests;
        expect(sent!.tools).toEqual([]);
        expect(sent!.maxOutputTokens).toBe(500);
        // The canary: the request holds the suite's synthetic data only, masked.
        expect(JSON.stringify(sent)).toBe(
          JSON.stringify({
            system: 'You write a product description.',
            messages: [
              {
                role: 'user',
                blocks: [{ type: 'text', text: `Synthetic rice 1 kg, reply to ${MASKED}` }],
              },
            ],
            tools: [],
            maxOutputTokens: 500,
          }),
        );
        // No Market, capability, seller or guest counter moved: only the evaluation month.
        const keys = [...usageStore.counters.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(new RegExp(`^${market.marketId}\\|month\\|.*\\|evaluation\\|$`));
        expect(usageStore.counters.get(keys[0]!)).toEqual({ held: 200, spent: 200 });
        expect(usageStore.reservations.size).toBe(0);
        expect(usageStore.calls.map((call) => call.capability)).toEqual([AI_EVALUATION_USAGE]);
      },
    );

    it('runs for an admin of the panel (the playground), not acting as anyone', async () => {
      const { gateway } = evaluationHarness();
      expect(
        await gateway.run(
          'alpha.admin-writer',
          's-2',
          'anthropic',
          'model-fast',
          evalAdminContext(AU),
        ),
      ).toMatchObject({ kind: 'done', outcome: 'ok' });
    });

    it.each([
      ['a seller', () => evalSellerContext(AU), 'alpha.admin-writer', 's-1', 'access'],
      [
        'a buyer or guest',
        () => testCallContext(AU, 'anonymous'),
        'alpha.admin-writer',
        's-1',
        'access',
      ],
      [
        'an acting-as session (R3)',
        () => evalAdminContext(AU, true),
        'alpha.admin-writer',
        's-1',
        'access',
      ],
      [
        'a capability without a suite',
        () => testCallContext(AU, 'system'),
        'alpha.tool-chat',
        's-1',
        'unknown-capability',
      ],
      [
        'an unknown capability',
        () => testCallContext(AU, 'system'),
        'alpha.nothing',
        's-1',
        'unknown-capability',
      ],
      [
        'an unknown sample',
        () => testCallContext(AU, 'system'),
        'alpha.admin-writer',
        's-9',
        'unknown-sample',
      ],
    ])('refuses %s and calls nothing', async (_name, context, capability, sampleId, reason) => {
      const { gateway, provider, usageStore } = evaluationHarness();
      expect(await gateway.run(capability, sampleId, 'anthropic', 'model-fast', context())).toEqual(
        { kind: 'refused', reason },
      );
      expect(provider.requests).toHaveLength(0);
      expect(usageStore.counters.size).toBe(0);
    });

    it('refuses a family the catalogue does not hold under the provider', async () => {
      const { gateway, provider } = evaluationHarness();
      const system = testCallContext(AU, 'system');
      expect(await gateway.run('alpha.admin-writer', 's-1', 'other', 'model-fast', system)).toEqual(
        { kind: 'refused', reason: 'unknown-model' },
      );
      expect(
        await gateway.run('alpha.admin-writer', 's-1', 'anthropic', 'model-nothing', system),
      ).toEqual({ kind: 'refused', reason: 'unknown-model' });
      expect(provider.requests).toHaveLength(0);
    });

    it('refuses a sample whose request came to carry tools', async () => {
      const suite = new FakeSuite('alpha.admin-writer');
      const { gateway, provider } = evaluationHarness({ suites: [suite] });
      suite.withTools = true;
      expect(
        await gateway.run(
          'alpha.admin-writer',
          's-1',
          'anthropic',
          'model-fast',
          testCallContext(AU, 'system'),
        ),
      ).toEqual({ kind: 'refused', reason: 'tools' });
      expect(provider.requests).toHaveLength(0);
    });

    describe('closed', () => {
      const system = () => testCallContext(ZZ, 'system');
      const run = (harness: ReturnType<typeof evaluationHarness>) =>
        harness.gateway.run('alpha.admin-writer', 's-1', 'anthropic', 'model-fast', system());

      it('by the kill switch', async () => {
        const harness = evaluationHarness({ killed: true });
        expect(await run(harness)).toEqual({ kind: 'closed', status: 'closed-off' });
        expect(harness.provider.requests).toHaveLength(0);
      });

      it("by the Market's emergency stop, and when its settings cannot be read (R8)", async () => {
        const harness = evaluationHarness();
        harness.controls.stopped.add('ZZ');
        expect(await run(harness)).toEqual({ kind: 'closed', status: 'closed-off' });
        harness.controls.stopped.clear();
        harness.controls.failing = true;
        expect(await run(harness)).toEqual({ kind: 'closed', status: 'closed-off' });
        expect(harness.provider.requests).toHaveLength(0);
      });

      it('by an evaluation budget of 0 (the default), holding nothing', async () => {
        const harness = evaluationHarness({ budget: {} });
        expect(await run(harness)).toEqual({ kind: 'closed', status: 'closed-budget' });
        expect(harness.provider.requests).toHaveLength(0);
        expect(harness.usageStore.reservations.size).toBe(0);
      });

      it('by the close rule: the Market month share at the saver threshold (Option B)', async () => {
        const harness = evaluationHarness({
          budget: { evaluationMonthMicroUsd: 10_000_000, marketMonthMicroUsd: 0 },
        });
        expect(await run(harness)).toEqual({ kind: 'closed', status: 'closed-saver' });
        expect(harness.provider.requests).toHaveLength(0);
      });

      it('when the model has no usable route in the Market (its key removed)', async () => {
        const harness = evaluationHarness({ keyed: ['AU'] });
        expect(await run(harness)).toEqual({ kind: 'closed', status: 'closed-off' });
      });
    });

    it('refuses a sample over the capability input cap without a call (outcome refused)', async () => {
      const suite = new FakeSuite('alpha.admin-writer');
      suite.oversized = true;
      const { gateway, provider } = evaluationHarness({ suites: [suite] });
      expect(
        await gateway.run(
          'alpha.admin-writer',
          's-1',
          'anthropic',
          'model-fast',
          testCallContext(AU, 'system'),
        ),
      ).toEqual({ kind: 'done', outcome: 'refused', turn: null, attempt: null, costMicroUsd: 0 });
      expect(provider.requests).toHaveLength(0);
    });

    it("answers a provider's failure as the sample's outcome, with the attempt", async () => {
      const { gateway, provider, usageStore } = evaluationHarness();
      provider.answer = () => Promise.reject(new ModelProviderError('rate-limited'));
      const result = await gateway.run(
        'alpha.admin-writer',
        's-1',
        'anthropic',
        'model-fast',
        testCallContext(AU, 'system'),
      );
      expect(result).toMatchObject({ kind: 'done', outcome: 'rate-limited', turn: null });
      expect(result.kind === 'done' && result.attempt?.route.route).toBe('anthropic-api');
      expect(usageStore.reservations.size).toBe(0);
    });

    it('returns the turn to the caller, who grades it (the gateway stores no text)', async () => {
      const { gateway, provider } = evaluationHarness();
      provider.answer = () => Promise.resolve(answer('Certified halal rice'));
      const result = await gateway.run(
        'alpha.admin-writer',
        's-1',
        'anthropic',
        'model-fast',
        testCallContext(AU, 'system'),
      );
      expect(result.kind === 'done' && result.turn).toEqual(answer('Certified halal rice'));
    });
  });

  it('closedBySaverThreshold: closed at or above the threshold, never without a month cap', () => {
    expect(closedBySaverThreshold(null, 80)).toBe(false);
    expect(closedBySaverThreshold(0.79, 80)).toBe(false);
    expect(closedBySaverThreshold(0.8, 80)).toBe(true);
    expect(closedBySaverThreshold(1, 100)).toBe(true);
  });
});
