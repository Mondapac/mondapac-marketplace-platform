import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_AI_VIEW } from '../../contracts/permissions';
import {
  AI_DESCRIPTION_WRITER_CODE,
  AI_DESCRIPTION_WRITER_TIER_CODE,
} from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

/**
 * `settings.view-ai-settings`: an admin reads the Market's AI settings (the description writer's
 * switch and its model tier) with their versions.
 */
export class ViewAiSettings extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-ai-settings',
    rule: { kind: 'permissions', allOf: [SETTINGS_AI_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context, [
      AI_DESCRIPTION_WRITER_CODE,
      AI_DESCRIPTION_WRITER_TIER_CODE,
    ]);
  }
}
