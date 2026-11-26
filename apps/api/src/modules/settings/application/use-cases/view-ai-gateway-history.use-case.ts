import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import { AI_GATEWAY_CODES } from '../../domain/definitions';
import {
  viewSettingHistory,
  type HistoryInput,
  type SettingHistoryDependencies,
  type SettingHistoryView,
} from '../ai-settings-history';
import type { SettingsFailure } from '../settings-flow';

export type { SettingHistoryView } from '../ai-settings-history';

/**
 * `settings.view-ai-gateway-history` (AI Gateway G4d3): an admin holding the AI Gateway view key
 * reads the latest changes of one AI Gateway setting of the Market (the emergency stop, a cap or a
 * capability switch), newest first, at most 50, for the panel's revert.
 */
export class ViewAiGatewayHistory extends UseCase<
  HistoryInput,
  readonly SettingHistoryView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-gateway-history',
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
    return viewSettingHistory(this.deps, context, AI_GATEWAY_CODES, input ?? {});
  }
}
