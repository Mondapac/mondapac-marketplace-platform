import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_SETTINGS_VIEW } from '../../contracts/permissions';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { viewSettings, type SettingsFailure, type SettingsView } from '../settings-flow';

export type { SettingsView };

/** `promotions.view-promotions-settings`: an admin reads the promotions state of the Market (default off). */
export class ViewPromotionsSettings extends UseCase<
  Record<string, never>,
  SettingsView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-promotions-settings',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context);
  }
}
