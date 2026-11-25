import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_OFFER_REVIEW_MANAGE } from '../../contracts/permissions';
import { OFFER_REVIEW_CODES } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSettings, type SettingChangeView, type SettingsFailure } from '../settings-flow';

interface Input {
  /** `[{ code, value, expectedVersion }]`, each code of the Offer review policy at most once. */
  readonly changes?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/**
 * `settings.change-offer-review-settings`: an admin saves the Offer review page, every changed
 * setting with the version they saw, all or nothing. Refused in acting-as, audited per setting, and
 * a stale version of any setting is a conflict that saves nothing.
 */
export class ChangeOfferReviewSettings extends UseCase<
  Input,
  readonly SettingChangeView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-offer-review-settings',
    rule: { kind: 'permissions', allOf: [SETTINGS_OFFER_REVIEW_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly SettingChangeView[], SettingsFailure>> {
    return changeSettings(this.deps, context, OFFER_REVIEW_CODES, input ?? {});
  }
}
