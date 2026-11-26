import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices } from '../../../../platform/ai/model-choices';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { AI_MODEL_CODES } from '../../domain/definitions';
import { revertAiSetting, type RevertInput } from '../ai-settings-history';
import type { SettingsDependencies } from '../settings-dependencies';
import type { SettingChangeView, SettingsFailure } from '../settings-flow';
import { aiModelIssues } from '../ai-model-checks';

/**
 * `settings.revert-ai-models-setting` (AI Gateway G4d3, design section 8): an admin holding the
 * protected AI models key brings one AI model setting back to the value of an earlier version. The
 * External models tab's server checks run again on the page as it would stand (a family since
 * retired, or no longer usable in the Market, is refused), then it is a forward change like any
 * other. Every revert spends the admin's fresh two-step code (`settings.ai-settings.revert`).
 */
export class RevertAiModelsSetting extends UseCase<
  RevertInput,
  SettingChangeView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.revert-ai-models-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_MODELS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
    private readonly choices: Pick<AiModelChoices, 'check'>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RevertInput,
  ): Promise<Result<SettingChangeView, SettingsFailure>> {
    return revertAiSetting(this.deps, context, AI_MODEL_CODES, input ?? {}, (values, changed) =>
      aiModelIssues(this.choices, context.market.marketId, values, changed),
    );
  }
}
