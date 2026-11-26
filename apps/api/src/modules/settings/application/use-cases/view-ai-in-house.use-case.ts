import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices, InHouseOption } from '../../../../platform/ai/model-choices';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import { AI_IN_HOUSE_CODES } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

export interface AiInHouseView {
  /** Each task type's stage, model and shares, and the rollback limits, with their versions. */
  readonly settings: readonly SettingView[];
  /**
   * Per task type, every in-house family of the route catalogue and why it cannot be the task
   * type's model in a stage other than off now (null: it can). Code and configuration only.
   */
  readonly options: Readonly<Record<string, readonly InHouseOption[]>>;
}

/**
 * `settings.view-ai-in-house`: an admin reads the Market's in-house model settings (the Mondapac
 * Intelligence tab, docs/design/domain/platform-ai.md section 8; AI Gateway G6b) and the in-house
 * families each task type may take now. Seen with the AI Gateway view key.
 */
export class ViewAiInHouse extends UseCase<Record<string, never>, AiInHouseView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-in-house',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
    private readonly choices: Pick<AiModelChoices, 'inHouseOptions'>,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<AiInHouseView, SettingsFailure>> {
    const settings = await viewSettings(this.deps, context, AI_IN_HOUSE_CODES);
    if (!settings.ok) return settings;
    return ok({
      settings: settings.value,
      options: this.choices.inHouseOptions(context.market.marketId),
    });
  }
}
