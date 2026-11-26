import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_MANAGE } from '../../contracts/permissions';
import { AI_GATEWAY_CODES, capPairIssues } from '../../domain/definitions';
import { revertAiSetting, type RevertInput } from '../ai-settings-history';
import type { SettingsDependencies } from '../settings-dependencies';
import type { SettingChangeView, SettingsFailure } from '../settings-flow';

/**
 * `settings.revert-ai-gateway-setting` (AI Gateway G4d3, design section 8): an admin holding the
 * protected AI Gateway key brings one AI Gateway setting (the emergency stop, a cap or a capability
 * switch) back to the value of an earlier version, from the version in force they saw. A forward
 * change: a new version with its history, audit row and review; the buyer chat's day cap is still
 * never above its month cap. Every revert spends the admin's fresh two-step code
 * (`settings.ai-settings.revert`); refused in acting-as; a stale version is a conflict.
 */
export class RevertAiGatewaySetting extends UseCase<
  RevertInput,
  SettingChangeView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.revert-ai-gateway-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RevertInput,
  ): Promise<Result<SettingChangeView, SettingsFailure>> {
    return revertAiSetting(this.deps, context, AI_GATEWAY_CODES, input ?? {}, (values) =>
      capPairIssues(values),
    );
  }
}
