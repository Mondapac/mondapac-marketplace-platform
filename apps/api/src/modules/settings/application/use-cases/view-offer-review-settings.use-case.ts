import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_OFFER_REVIEW_VIEW } from '../../contracts/permissions';
import { OFFER_REVIEW_CODES } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

/**
 * `settings.view-offer-review-settings`: an admin reads the Market's Offer review policy (mode,
 * new seller count, reference price rules, sampling percent, badge rule) with their versions.
 */
export class ViewOfferReviewSettings extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-offer-review-settings',
    rule: { kind: 'permissions', allOf: [SETTINGS_OFFER_REVIEW_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context, OFFER_REVIEW_CODES);
  }
}
