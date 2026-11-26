import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices } from '../../../../platform/ai/model-choices';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { AI_IN_HOUSE_CODES, AI_MODEL_CODES } from '../../domain/definitions';
import { revertAiSetting, type RevertInput } from '../ai-settings-history';
import type { SettingsDependencies } from '../settings-dependencies';
import type { SettingChangeView, SettingsFailure } from '../settings-flow';
import { aiInHouseIssues, aiModelIssues } from '../ai-model-checks';

/** The AI Models page's codes: the External models tab and the Mondapac Intelligence tab (G6b). */
const AI_MODELS_PAGE_CODES: readonly string[] = [...AI_MODEL_CODES, ...AI_IN_HOUSE_CODES];

/**
 * `settings.revert-ai-models-setting` (AI Gateway G4d3, design section 8): an admin holding the
 * protected AI models key brings one AI model setting back to the value of an earlier version. The
 * External models tab's server checks run again on the page as it would stand (a family since
 * retired, or no longer usable in the Market, is refused), then it is a forward change like any
 * other. Every revert spends the admin's fresh two-step code (`settings.ai-settings.revert`). An
 * in-house setting of the Mondapac Intelligence tab (G6b) is reverted here too, after the same
 * server checks as its change: "roll back to the previous version" of the in-house model is a
 * revert of its model setting, accepted only while that version is usable and evaluated.
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
    private readonly choices: Pick<AiModelChoices, 'check' | 'checkInHouse'>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RevertInput,
  ): Promise<Result<SettingChangeView, SettingsFailure>> {
    const marketId = context.market.marketId;
    return revertAiSetting(
      this.deps,
      context,
      AI_MODELS_PAGE_CODES,
      input ?? {},
      (values, changed) => [
        ...aiModelIssues(this.choices, marketId, values, changed),
        ...aiInHouseIssues(this.choices, marketId, values, changed),
      ],
    );
  }
}
