import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AiEvaluationControl,
  EvaluationEstimate,
} from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { SETTINGS_AI_EVALUATION_STEP_UP } from '../../contracts/step-up';
import { AiEvaluationRequested } from '../../domain/audit';
import type { SettingsDependencies } from '../settings-dependencies';
import { adminAccountId, type SettingsFailure } from '../settings-flow';
import { modelOf } from './estimate-ai-evaluation.use-case';

interface Input {
  readonly provider?: unknown;
  readonly family?: unknown;
  /** The estimate the admin confirmed (GET .../evaluations/estimate), US micro-dollars. */
  readonly expectedEstimateMicroUsd?: unknown;
}

export interface AiEvaluationQueued {
  readonly runId: string;
  readonly estimate: EvaluationEstimate;
}

const logger = new Logger('RunAiEvaluation');

/**
 * `settings.run-ai-evaluation`: an admin holding the protected AI models key starts an evaluation
 * run of a model in the Market (AI Gateway G4c; docs/design/domain/platform-ai.md section 8, Tab 1,
 * Evaluation): each capability's synthetic evaluation set on the real model, in the background
 * job, paid from the evaluation budget. The estimate is computed again and must equal the one the
 * admin confirmed (else `validation.failed`, `expectedEstimateMicroUsd` stale); nothing may block
 * the run. Then, in one unit: the admin's fresh two-step code for `settings.ai-evaluation.run` is
 * spent, the run is queued (one open run per model and Market) and audited (numbers only). Refused
 * in an acting-as session. A result is only a pass candidate.
 */
export class RunAiEvaluation extends UseCase<Input, AiEvaluationQueued, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.run-ai-evaluation',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_MODELS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
    private readonly control: Pick<AiEvaluationControl, 'estimate' | 'enqueue'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<AiEvaluationQueued, SettingsFailure>> {
    const adminId = adminAccountId(context);
    if (adminId === null) return err({ code: 'access.denied' });
    const model = modelOf(input);
    if (Array.isArray(model)) return err({ code: 'validation.failed', fields: model });
    const expected = input.expectedEstimateMicroUsd;
    if (!Number.isSafeInteger(expected) || (expected as number) < 0) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'expectedEstimateMicroUsd', code: 'type' }],
      });
    }
    let estimate: EvaluationEstimate;
    try {
      estimate = await this.control.estimate(context, model.provider, model.family);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (estimate.blockers.length > 0) {
      return err({
        code: 'validation.failed',
        fields: estimate.blockers.map((blocker) => ({ path: 'family', code: blocker })),
      });
    }
    if (estimate.estimateMicroUsd !== expected) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'expectedEstimateMicroUsd', code: 'stale' }],
      });
    }
    const queued = await this.deps.unitOfWork.run<string, SettingsFailure>(
      context.market,
      async () => {
        const spent = await this.deps.stepUp.consume(context, SETTINGS_AI_EVALUATION_STEP_UP);
        if (!spent.ok) {
          const refusal = spent.error;
          if (
            refusal.code === 'second-factor.required' ||
            refusal.code === 'second-factor.enrolment-required'
          ) {
            return err({ code: refusal.code, actionKey: refusal.actionKey });
          }
          return err({
            code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied',
          });
        }
        const runId = await this.control.enqueue(context.market, estimate, adminId);
        // Another admin started a run of the model meanwhile: nothing is kept, the proof included.
        if (runId === null) {
          return err({ code: 'validation.failed', fields: [{ path: 'family', code: 'run-open' }] });
        }
        await this.deps.audit.record(
          context,
          AiEvaluationRequested.entry(runId as Id, {
            after: {
              capabilities: estimate.capabilities.length,
              samples: estimate.capabilities.reduce((total, item) => total + item.samples, 0),
              estimateMicroUsd: estimate.estimateMicroUsd,
            },
          }),
        );
        return ok(runId);
      },
    );
    if (!queued.ok) return queued;
    logger.log({
      msg: 'settings.ai-evaluation.requested',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      runId: queued.value,
    });
    return ok({ runId: queued.value, estimate });
  }
}
