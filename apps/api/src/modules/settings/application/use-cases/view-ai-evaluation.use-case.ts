import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AiEvaluationControl,
  EvaluationRunDetail,
} from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import type { SettingsFailure } from '../settings-flow';

export type { EvaluationRunDetail };

export type AiEvaluationFailure = SettingsFailure | { readonly code: 'ai.evaluation-not-found' };

/**
 * `settings.view-ai-evaluation`: an admin reads one AI evaluation run of the Market (AI Gateway
 * G4c): each capability's versions and verdict, and each sample's outcome, check codes, route,
 * tokens, cost and latency. No model text is stored, so none is shown. A run of another Market is
 * not found. Seen with the AI Gateway view key.
 */
export class ViewAiEvaluation extends UseCase<
  { readonly runId?: unknown },
  EvaluationRunDetail,
  AiEvaluationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-evaluation',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly control: Pick<AiEvaluationControl, 'detail'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly runId?: unknown },
  ): Promise<Result<EvaluationRunDetail, AiEvaluationFailure>> {
    const raw = input?.runId;
    const runId = typeof raw === 'string' ? parseId(raw) : null;
    if (runId === null || !runId.ok) return err({ code: 'ai.evaluation-not-found' });
    const detail = await this.control.detail(context.market, runId.value);
    return detail === null ? err({ code: 'ai.evaluation-not-found' }) : ok(detail);
  }
}
