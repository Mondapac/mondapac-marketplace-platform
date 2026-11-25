import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices, ModelOption } from '../../../../platform/ai/model-choices';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import { AI_MODEL_CODES } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

export interface AiModelsView {
  /** Each task type's list, saver model and the saver threshold, with their versions. */
  readonly settings: readonly SettingView[];
  /**
   * Per task type, every model family of the route catalogue and why it cannot be chosen in the
   * Market now (null: it can): what the External models tab offers. Code and configuration only.
   */
  readonly options: Readonly<Record<string, readonly ModelOption[]>>;
}

/**
 * `settings.view-ai-models`: an admin reads the Market's AI model choice (the External models tab,
 * docs/design/domain/platform-ai.md section 7; AI Gateway G4b) and the families each task type
 * may take now. Seen with the AI Gateway view key.
 */
export class ViewAiModels extends UseCase<Record<string, never>, AiModelsView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-models',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
    private readonly choices: Pick<AiModelChoices, 'options'>,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<AiModelsView, SettingsFailure>> {
    const settings = await viewSettings(this.deps, context, AI_MODEL_CODES);
    if (!settings.ok) return settings;
    return ok({ settings: settings.value, options: this.choices.options(context.market.marketId) });
  }
}
