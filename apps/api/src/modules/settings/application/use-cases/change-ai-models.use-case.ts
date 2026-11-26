import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices } from '../../../../platform/ai/model-choices';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { SETTINGS_AI_MODELS_STEP_UP } from '../../contracts/step-up';
import { AI_MODEL_CODES } from '../../domain/definitions';
import { aiModelIssues } from '../ai-model-checks';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /**
   * `[{ code, value, expectedVersion }]`, each code at most once: `ai-models-<task>` (`none` or 1
   * to 3 model families, comma-separated, in the order to try), `ai-saver-<task>` (`none` or one
   * family) and `ai-saver-percent` (50 to 99).
   */
  readonly changes?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/**
 * `settings.change-ai-models`: an admin holding the protected AI models key saves the External
 * models tab (docs/design/domain/platform-ai.md sections 7 and 8; AI Gateway G4b), every changed
 * setting with the version they saw, all or nothing. Every change that saves something spends the
 * admin's fresh two-step code in the change's unit (`settings.ai-models.change`). The server checks of the tab run in that
 * unit on the page as it would stand: each family of a changed list is in the route catalogue,
 * once, and usable in the Market for every capability of its task type (Hassan's check, region,
 * key, not retired, evaluated); a saver model meets the same checks, goes before a list and is
 * cheaper than its model 1. Refused in acting-as, audited per setting, reviewed at high risk where
 * the area is reviewed; the gateway reads the new lists on its next call.
 */
export class ChangeAiModels extends UseCase<Input, readonly SettingChangeView[], SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-ai-models',
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
    input: Input,
  ): Promise<Result<readonly SettingChangeView[], SettingsFailure>> {
    return changeSettings(
      this.deps,
      context,
      AI_MODEL_CODES,
      input ?? {},
      // Every change that saves something; asking for the values in force changes nothing.
      { action: SETTINGS_AI_MODELS_STEP_UP, when: (_code, was, next) => was !== next },
      (values, changed) => aiModelIssues(this.choices, context.market.marketId, values, changed),
    );
  }
}
