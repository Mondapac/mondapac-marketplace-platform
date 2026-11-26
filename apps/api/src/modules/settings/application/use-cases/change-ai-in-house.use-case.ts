import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices } from '../../../../platform/ai/model-choices';
import { SETTINGS_AI_MODELS_MANAGE } from '../../contracts/permissions';
import { SETTINGS_AI_IN_HOUSE_STEP_UP } from '../../contracts/step-up';
import { AI_IN_HOUSE_CODES, loosensInHouse } from '../../domain/definitions';
import { aiInHouseIssues } from '../ai-model-checks';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /**
   * `[{ code, value, expectedVersion }]`, each code at most once: `ai-in-house-stage-<task>` (off,
   * shadow, percent, default), `ai-in-house-model-<task>` (`none` or one in-house family),
   * `ai-in-house-shadow-<task>` (0 to 100), `ai-in-house-rollout-<task>` (0 to 99),
   * `ai-in-house-rollback-errors` and `-guard` (1 to 50 tenths of a percent) and
   * `ai-in-house-rollback-sample` (100 to 10,000 calls).
   */
  readonly changes?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/**
 * `settings.change-ai-in-house`: an admin holding the protected AI models key saves the Mondapac
 * Intelligence tab (docs/design/domain/platform-ai.md section 8, Tab 2; AI Gateway G6b), every
 * changed setting with the version they saw, all or nothing. A change that sends more to the
 * in-house model or slows its rollback (`loosensInHouse`) spends the admin's fresh two-step code in
 * the change's unit (`settings.ai-in-house.raise`); switching a stage off, lowering a share or
 * tightening a rollback limit spends none. The server checks run in that unit on the page as it
 * would stand, before any proof is spent: a stage the gateway serves, the owner's approval for
 * shadow, a model for any stage but off, the in-house route usable in the Market with an
 * evaluation pass for every capability of the task type, a share above 0 for its stage; the
 * rollback limits stay within the server ceiling and the sample floor (their definitions). Refused
 * in acting-as, audited per setting, reviewed at high risk where the area is reviewed.
 */
export class ChangeAiInHouse extends UseCase<Input, readonly SettingChangeView[], SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-ai-in-house',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_MODELS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
    private readonly choices: Pick<AiModelChoices, 'checkInHouse'>,
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
      AI_IN_HOUSE_CODES,
      input ?? {},
      { action: SETTINGS_AI_IN_HOUSE_STEP_UP, when: loosensInHouse },
      (values, changed) => aiInHouseIssues(this.choices, context.market.marketId, values, changed),
    );
  }
}
