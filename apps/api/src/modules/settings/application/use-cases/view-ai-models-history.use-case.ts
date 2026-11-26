import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import { AI_IN_HOUSE_CODES, AI_MODEL_CODES } from '../../domain/definitions';
import {
  viewSettingHistory,
  type HistoryInput,
  type SettingHistoryDependencies,
  type SettingHistoryView,
} from '../ai-settings-history';
import type { SettingsFailure } from '../settings-flow';

/** The AI Models page's codes: the External models tab and the Mondapac Intelligence tab (G6b). */
const AI_MODELS_PAGE_CODES: readonly string[] = [...AI_MODEL_CODES, ...AI_IN_HOUSE_CODES];

/**
 * `settings.view-ai-models-history` (AI Gateway G4d3): an admin holding the AI Gateway view key
 * reads the latest changes of one AI model setting of the Market (a task type's list or saver
 * model, the saver threshold, or an in-house setting of the Mondapac Intelligence tab, G6b), newest
 * first, at most 50, for the panel's revert.
 */
export class ViewAiModelsHistory extends UseCase<
  HistoryInput,
  readonly SettingHistoryView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-models-history',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingHistoryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: HistoryInput,
  ): Promise<Result<readonly SettingHistoryView[], SettingsFailure>> {
    return viewSettingHistory(this.deps, context, AI_MODELS_PAGE_CODES, input ?? {});
  }
}
