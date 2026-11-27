import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AiModelChoices, InHouseOption } from '../../../../platform/ai/model-choices';
import type {
  InHouseRollbackStatus,
  InHouseRollbackStatusRead,
} from '../../../../platform/ai/own-model/in-house-rollback-status';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import { AI_IN_HOUSE_CODES } from '../../domain/definitions';
import { inHouseChangedAt } from '../ai-gateway-controls-reader';
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
  /**
   * Each task type's latest auto-rollback (G6d3), with whether it holds the live stage off now (no
   * admin change of the task type's stage, model or percent share since). A task type never rolled
   * back is left out. Numbers and codes only (AI Gateway G6e2).
   */
  readonly rollbacks: readonly InHouseRollbackStatus[];
}

/**
 * `settings.view-ai-in-house`: an admin reads the Market's in-house model settings (the Mondapac
 * Intelligence tab, docs/design/domain/platform-ai.md section 8; AI Gateway G6b) and the in-house
 * families each task type may take now, and (G6e2) each task type's latest auto-rollback. Seen
 * with the AI Gateway view key.
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
    private readonly rollbacks: Pick<InHouseRollbackStatusRead, 'status'>,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<AiInHouseView, SettingsFailure>> {
    const settings = await viewSettings(this.deps, context, AI_IN_HOUSE_CODES);
    if (!settings.ok) return settings;
    // Held off is judged against the same change times the gateway uses (inHouseChangedAt).
    const rollbacks = await this.rollbacks.status(context.market, inHouseChangedAt(settings.value));
    return ok({
      settings: settings.value,
      options: this.choices.inHouseOptions(context.market.marketId),
      rollbacks,
    });
  }
}
