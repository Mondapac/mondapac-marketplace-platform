import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelUsage, ModelUsageView } from '../../../../platform/ai/usage/ai-model-usage';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import type { SettingsFailure } from '../settings-flow';

export type { ModelUsageView };

/**
 * `settings.view-ai-model-usage`: an admin reads the Market's AI usage of the last 30 days per model
 * family (the scorecard: calls, failures, stand-ins, cost and p95 latency, evaluation passes) and
 * per task type (calls, tokens and their cost on each family, for the change preview's monthly
 * estimate). AI Gateway G5e; docs/design/domain/platform-ai.md section 8, Tab 1. Numbers, codes and
 * catalogue names only. Seen with the AI Gateway view key.
 */
export class ViewAiModelUsage extends UseCase<
  Record<string, never>,
  ModelUsageView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-model-usage',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly usage: Pick<AiModelUsage, 'read'>,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<ModelUsageView, SettingsFailure>> {
    return ok(await this.usage.read(context.market));
  }
}
