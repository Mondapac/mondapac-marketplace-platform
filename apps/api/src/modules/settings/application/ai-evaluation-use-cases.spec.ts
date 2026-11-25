import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  ADMIN_ID,
  evalAdminContext,
  evalSellerContext,
  evaluationHarness,
} from '../../../../test/support/ai-evaluations';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { RecordingReview } from '../../../../test/support/system-request-fakes';
import { AI_PLAYGROUND_RUNS_PER_ADMIN_DAY } from '../../../platform/ai/evaluations/evaluation-control';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type {
  AccessDecision,
  AccessDeclaration,
  StepUpProofConsumer,
} from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { SETTINGS_AI_GATEWAY_VIEW, SETTINGS_AI_MODELS_MANAGE } from '../contracts/permissions';
import { SETTINGS_AI_EVALUATION_STEP_UP } from '../contracts/step-up';
import { SETTINGS_AUDIT_ACTIONS } from '../domain/audit';
import type { SettingsDependencies } from './settings-dependencies';
import { CancelAiEvaluation } from './use-cases/cancel-ai-evaluation.use-case';
import { EstimateAiEvaluation } from './use-cases/estimate-ai-evaluation.use-case';
import { RunAiEvaluation } from './use-cases/run-ai-evaluation.use-case';
import { RunAiPlayground } from './use-cases/run-ai-playground.use-case';
import { ViewAiEvaluation } from './use-cases/view-ai-evaluation.use-case';
import { ViewAiEvaluations } from './use-cases/view-ai-evaluations.use-case';
import { ViewAiPlaygroundSamples } from './use-cases/view-ai-playground-samples.use-case';

// The evaluation and playground use cases of settings (AI Gateway G4c) on the real control and
// evaluation gateway, in memory, on both Market fixtures: the permission each one declares, the
// two-step code spent only by a run, acting-as refused, the audit row (numbers only), a stale
// estimate, the playground's daily limit, and ids-only bodies.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ACTIONS = new Set<string>(SETTINGS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('AI evaluation use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  let harness: ReturnType<typeof evaluationHarness>;
  let granted: Set<string>;
  let declarations: string[];
  let audit: RecordingAudit;
  let deps: SettingsDependencies;
  let spentProofs: string[];
  let proofLeft: boolean;
  let gate: ReturnType<typeof createUseCaseGate>;

  const stepUp: StepUpProofConsumer = {
    consume: (_context: CallContext, actionKey: string) => {
      if (!proofLeft) return Promise.resolve(err({ code: 'second-factor.required', actionKey }));
      spentProofs.push(actionKey);
      return Promise.resolve(ok({ sessionId: ADMIN_ID as never, verifiedAt: harness.clock.now() }));
    },
  };
  const admin = () => evalAdminContext(market);
  const actingAs = () => evalAdminContext(market, true);

  const useCases = () => ({
    list: new ViewAiEvaluations(gate, harness.control),
    detail: new ViewAiEvaluation(gate, harness.control),
    estimate: new EstimateAiEvaluation(gate, harness.control),
    run: new RunAiEvaluation(gate, deps, harness.control),
    cancel: new CancelAiEvaluation(gate, deps, harness.control),
    samples: new ViewAiPlaygroundSamples(gate, harness.control),
    playground: new RunAiPlayground(gate, deps, harness.control),
  });

  const estimateOf = async () => {
    const result = await useCases().estimate.execute(admin(), {
      provider: 'anthropic',
      family: 'model-fast',
    });
    if (!result.ok) throw new Error('no estimate');
    return result.value.estimateMicroUsd;
  };
  const start = async (context = admin(), expected?: number) =>
    useCases().run.execute(context, {
      provider: 'anthropic',
      family: 'model-fast',
      expectedEstimateMicroUsd: expected ?? (await estimateOf()),
    });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    harness = evaluationHarness();
    granted = new Set([SETTINGS_AI_GATEWAY_VIEW.key, SETTINGS_AI_MODELS_MANAGE.key]);
    declarations = [];
    gate = createUseCaseGate(markets, {
      check: (_context, declaration: AccessDeclaration): Promise<AccessDecision> => {
        declarations.push(declaration.name);
        const rule = declaration.rule as { kind: string; allOf?: readonly string[] };
        const allowed = rule.kind === 'permissions' && rule.allOf!.every((k) => granted.has(k));
        return Promise.resolve(
          allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    });
    audit = new RecordingAudit();
    deps = {
      unitOfWork: harness.unitOfWork,
      settings: {} as never,
      audit,
      clock: harness.clock,
      review: new RecordingReview(),
      stepUp,
    };
    spentProofs = [];
    proofLeft = true;
  });
  afterEach(() => jest.restoreAllMocks());

  it('declares the view key on reads and the protected AI models key on changes', () => {
    const keyOf = (useCase: { constructor: unknown }) =>
      (
        (useCase.constructor as { access: AccessDeclaration }).access.rule as {
          allOf: readonly string[];
        }
      ).allOf;
    const all = useCases();
    for (const read of [all.list, all.detail, all.estimate, all.samples]) {
      expect(keyOf(read)).toEqual([SETTINGS_AI_GATEWAY_VIEW.key]);
    }
    for (const change of [all.run, all.cancel, all.playground]) {
      expect(keyOf(change)).toEqual([SETTINGS_AI_MODELS_MANAGE.key]);
    }
  });

  it('refuses a run without the manage key (view only), queueing nothing', async () => {
    granted.delete(SETTINGS_AI_MODELS_MANAGE.key);
    expect(await start()).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(declarations).toContain('settings.run-ai-evaluation');
    expect(harness.store.runs.size).toBe(0);
    expect(spentProofs).toEqual([]);
  });

  it('queues a run: spends the two-step code, writes one audit row of numbers only', async () => {
    const expected = await estimateOf();
    const result = await start(admin(), expected);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spentProofs).toEqual([SETTINGS_AI_EVALUATION_STEP_UP]);
    expect(harness.store.runs.size).toBe(1);
    expect(audit.entries).toHaveLength(1);
    const [entry] = audit.entries;
    expect(entry).toMatchObject({
      action: 'settings.ai-evaluation.requested',
      targetId: result.value.runId,
      after: { capabilities: 2, samples: 4, estimateMicroUsd: expected },
    });
    expect(JSON.stringify(entry)).not.toMatch(/anthropic|model-fast|Synthetic/);
  });

  it('needs a fresh two-step code: without one nothing is queued or audited', async () => {
    proofLeft = false;
    expect(await start()).toEqual({
      ok: false,
      error: { code: 'second-factor.required', actionKey: SETTINGS_AI_EVALUATION_STEP_UP },
    });
    expect(harness.store.runs.size).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('refuses a stale estimate, a second open run and a blocked model', async () => {
    const expected = await estimateOf();
    expect(await start(admin(), expected + 1)).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'expectedEstimateMicroUsd', code: 'stale' }],
      },
    });
    expect((await start(admin(), expected)).ok).toBe(true);
    expect(await start(admin(), expected)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'family', code: 'run-open' }] },
    });
    expect(spentProofs).toHaveLength(1);
  });

  it.each([
    ['a missing estimate', { provider: 'anthropic', family: 'model-fast' }],
    [
      'a negative estimate',
      { provider: 'anthropic', family: 'model-fast', expectedEstimateMicroUsd: -1 },
    ],
    [
      'a family that is not a string',
      { provider: 'anthropic', family: 3, expectedEstimateMicroUsd: 0 },
    ],
  ])('refuses %s as validation.failed', async (_name, body) => {
    const result = await useCases().run.execute(admin(), body);
    expect(result.ok === false && result.error.code).toBe('validation.failed');
    expect(spentProofs).toEqual([]);
  });

  it('refuses every change in an acting-as session (R3), and a seller', async () => {
    for (const context of [actingAs(), evalSellerContext(market)]) {
      expect(await start(context, 0)).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(
        await useCases().playground.execute(context, {
          capability: 'alpha.admin-writer',
          sampleId: 's-1',
          families: ['model-fast', 'model-balanced'],
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    expect(harness.provider.requests).toHaveLength(0);
  });

  it('lists, shows and cancels a run of its own Market only', async () => {
    const queued = await start();
    if (!queued.ok) throw new Error('not queued');
    const { runId } = queued.value;
    const listed = await useCases().list.execute(admin(), {});
    expect(listed.ok && listed.value.runs.map((run) => run.id)).toEqual([runId]);
    expect((await useCases().detail.execute(admin(), { runId })).ok).toBe(true);
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    expect(await useCases().detail.execute(evalAdminContext(other), { runId })).toEqual({
      ok: false,
      error: { code: 'ai.evaluation-not-found' },
    });
    expect(await useCases().cancel.execute(evalAdminContext(other), { runId })).toEqual({
      ok: false,
      error: { code: 'ai.evaluation-not-found' },
    });
    const before = audit.entries.length;
    expect(await useCases().cancel.execute(admin(), { runId })).toEqual({
      ok: true,
      value: { runId },
    });
    // One audit row, the run id only (Hassan, PR 1367 L2); a refused cancel writes none.
    expect(audit.entries.slice(before)).toEqual([
      expect.objectContaining({ action: 'settings.ai-evaluation.cancelled', targetId: runId }),
    ]);
    expect(JSON.stringify(audit.entries.slice(before))).not.toMatch(/anthropic|model-fast/);
    expect(await useCases().cancel.execute(admin(), { runId })).toEqual({
      ok: false,
      error: { code: 'ai.evaluation-not-found' },
    });
    expect(audit.entries).toHaveLength(before + 1);
    expect(await useCases().detail.execute(admin(), { runId: 'not-an-id' })).toEqual({
      ok: false,
      error: { code: 'ai.evaluation-not-found' },
    });
  });

  describe('playground', () => {
    const play = (body: Record<string, unknown>, context = admin()) =>
      useCases().playground.execute(context, body);
    const body = {
      capability: 'alpha.admin-writer',
      sampleId: 's-1',
      families: ['model-fast', 'model-balanced'],
    };

    it('lists the synthetic samples for a viewer', async () => {
      granted.delete(SETTINGS_AI_MODELS_MANAGE.key);
      const samples = await useCases().samples.execute(admin(), {});
      expect(samples.ok && samples.value.map((suite) => suite.capability)).toEqual([
        'alpha.admin-writer',
        'alpha.seller-writer',
      ]);
    });

    it('answers two models side by side without a two-step code, audited with numbers only', async () => {
      const result = await play(body);
      expect(result.ok && result.value.map((answer) => answer.family)).toEqual([
        'model-fast',
        'model-balanced',
      ]);
      expect(spentProofs).toEqual([]);
      const cost = result.ok ? result.value.reduce((sum, item) => sum + item.costMicroUsd, 0) : -1;
      expect(audit.entries).toEqual([
        expect.objectContaining({
          action: 'settings.ai-playground.run',
          targetId: ADMIN_ID,
          after: { families: 2, spentMicroUsd: cost },
        }),
      ]);
      expect(JSON.stringify(audit.entries)).not.toMatch(/alpha|s-1|model-|Synthetic|rice/);
      expect(harness.store.runs.size).toBe(0);
    });

    it(`refuses the ${AI_PLAYGROUND_RUNS_PER_ADMIN_DAY + 1}th run of the Market day`, async () => {
      for (let index = 0; index < AI_PLAYGROUND_RUNS_PER_ADMIN_DAY; index += 1) {
        expect((await play(body)).ok).toBe(true);
      }
      expect(await play(body)).toEqual({
        ok: false,
        error: { code: 'ai.playground-limit-reached' },
      });
    });

    it.each([
      ['one family', { ...body, families: ['model-fast'] }, 'families'],
      ['the same family twice', { ...body, families: ['model-fast', 'model-fast'] }, 'families'],
      ['a sample id that is not a string', { ...body, sampleId: 1 }, 'sampleId'],
      ['an unknown sample', { ...body, sampleId: 's-9' }, 'sampleId'],
      ['a capability without a suite', { ...body, capability: 'alpha.tool-chat' }, 'capability'],
    ])('refuses %s before any call', async (_name, input, path) => {
      const result = await play(input);
      expect(result.ok === false && result.error).toMatchObject({
        code: 'validation.failed',
        fields: [expect.objectContaining({ path })],
      });
      expect(harness.provider.requests).toHaveLength(0);
      expect(harness.store.playgroundDays.size).toBe(0);
      expect(audit.entries).toEqual([]);
    });

    it('is refused for an anonymous caller', async () => {
      const result = await play(body, testCallContext(market, 'anonymous'));
      expect(result.ok).toBe(false);
    });
  });
});
