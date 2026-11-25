import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AiEvaluationControl,
  EvaluationRunList,
} from '../../../../platform/ai/evaluations/evaluation-control';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import type { SettingsFailure } from '../settings-flow';

export type { EvaluationRunList };

interface Input {
  /** Only this model family's runs; absent: every run. */
  readonly family?: unknown;
  /** The `next` of the page before. */
  readonly cursor?: unknown;
}

/**
 * `settings.view-ai-evaluations`: an admin lists the Market's AI evaluation runs, newest first, a
 * page at a time (AI Gateway G4c; docs/design/domain/platform-ai.md section 8, Tab 1, Evaluation).
 * Codes, numbers and ids only. Seen with the AI Gateway view key.
 */
export class ViewAiEvaluations extends UseCase<Input, EvaluationRunList, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-evaluations',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly control: Pick<AiEvaluationControl, 'list'>,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<EvaluationRunList, SettingsFailure>> {
    const { family, cursor } = input ?? {};
    if (family !== undefined && typeof family !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'family', code: 'type' }] });
    }
    if (cursor !== undefined && typeof cursor !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'cursor', code: 'type' }] });
    }
    const page = await this.control.list(context.market, family, cursor);
    if (page === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'cursor', code: 'value' }] });
    }
    return ok(page);
  }
}
