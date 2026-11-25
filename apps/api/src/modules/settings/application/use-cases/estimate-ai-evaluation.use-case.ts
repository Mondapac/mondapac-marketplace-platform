import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AiEvaluationControl,
  EvaluationEstimate,
} from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import type { FieldIssue, SettingsFailure } from '../settings-flow';

export type { EvaluationEstimate };

const PROVIDER = /^[a-z][a-z0-9-]{0,39}$/;
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,19}$/;

/** The provider and family of a model as the panel sends them; field issues otherwise. */
export function modelOf(input: {
  readonly provider?: unknown;
  readonly family?: unknown;
}): { provider: string; family: string } | FieldIssue[] {
  const fields: FieldIssue[] = [];
  const { provider, family } = input ?? {};
  if (typeof provider !== 'string' || !PROVIDER.test(provider)) {
    fields.push({ path: 'provider', code: 'value' });
  }
  if (typeof family !== 'string' || !FAMILY.test(family)) {
    fields.push({ path: 'family', code: 'value' });
  }
  return fields.length > 0 ? fields : { provider: provider as string, family: family as string };
}

/**
 * `settings.estimate-ai-evaluation`: an admin reads what an evaluation run of a model would cost
 * in the Market before starting it (AI Gateway G4c; design section 8, "The estimated cost is shown
 * first"): per capability with a suite the model can serve, its sample count and the sum of each
 * sample's reservation on the model's routes; the evaluation budget left; and what blocks a run
 * now (a route problem other than "not evaluated", an open run of the model, evaluations closed by
 * the close rule). Seen with the AI Gateway view key; it calls no model.
 */
export class EstimateAiEvaluation extends UseCase<
  { readonly provider?: unknown; readonly family?: unknown },
  EvaluationEstimate,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.estimate-ai-evaluation',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly control: Pick<AiEvaluationControl, 'estimate'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly provider?: unknown; readonly family?: unknown },
  ): Promise<Result<EvaluationEstimate, SettingsFailure>> {
    const model = modelOf(input);
    if (Array.isArray(model)) return err({ code: 'validation.failed', fields: model });
    try {
      return ok(await this.control.estimate(context, model.provider, model.family));
    } catch {
      // The Market's AI settings or the budget could not be read (ADR-0019 R8: off).
      return err({ code: 'access.unavailable' });
    }
  }
}
