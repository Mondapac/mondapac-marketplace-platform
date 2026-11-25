import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiEvaluationControl } from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { AiEvaluationCancelled } from '../../domain/audit';
import type { SettingsDependencies } from '../settings-dependencies';
import { adminAccountId } from '../settings-flow';
import type { AiEvaluationFailure } from './view-ai-evaluation.use-case';

const logger = new Logger('CancelAiEvaluation');

/**
 * `settings.cancel-ai-evaluation`: an admin holding the protected AI models key cancels a queued
 * or running evaluation run of the Market (AI Gateway G4c). Stopping spends nothing, so it needs
 * no two-step code (design section 8: switching something off never needs confirmation); the job
 * sees the cancel before its next sample, and the capabilities still pending are incomplete. A run
 * that is not open, or of another Market, is not found. The cancel and its audit row
 * (`settings.ai-evaluation.cancelled`, the run id only) are one unit. Refused in an acting-as session.
 */
export class CancelAiEvaluation extends UseCase<
  { readonly runId?: unknown },
  { readonly runId: string },
  AiEvaluationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.cancel-ai-evaluation',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_MODELS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<SettingsDependencies, 'unitOfWork' | 'audit'>,
    private readonly control: Pick<AiEvaluationControl, 'cancel'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly runId?: unknown },
  ): Promise<Result<{ readonly runId: string }, AiEvaluationFailure>> {
    if (adminAccountId(context) === null) return err({ code: 'access.denied' });
    const raw = input?.runId;
    const runId = typeof raw === 'string' ? parseId(raw) : null;
    if (runId === null || !runId.ok) return err({ code: 'ai.evaluation-not-found' });
    const id = runId.value;
    const cancelled = await this.deps.unitOfWork.run<true, AiEvaluationFailure>(
      context.market,
      async () => {
        if (!(await this.control.cancel(context.market, id))) {
          return err({ code: 'ai.evaluation-not-found' });
        }
        await this.deps.audit.record(context, AiEvaluationCancelled.entry(id, {}));
        return ok(true);
      },
    );
    if (!cancelled.ok) return cancelled;
    logger.log({
      msg: 'settings.ai-evaluation.cancelled',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
      runId: runId.value,
    });
    return ok({ runId: runId.value });
  }
}
