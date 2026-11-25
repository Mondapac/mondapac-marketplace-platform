import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_GATEWAY_VIEW } from '../../contracts/permissions';
import { AI_GATEWAY_CODES } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

/**
 * `settings.view-ai-gateway-settings`: an admin reads the Market's AI Gateway settings (the
 * emergency stop and the caps, docs/design/domain/platform-ai.md section 8) with their versions.
 * A cap is `none` or a whole number of US micro-dollars.
 */
export class ViewAiGatewaySettings extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-gateway-settings',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_GATEWAY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context, AI_GATEWAY_CODES);
  }
}
