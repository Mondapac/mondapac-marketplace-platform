import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SETTINGS_VIEW } from '../../contracts/permissions';
import { viewSettings, type SettingsFailure, type SettingsView } from '../settings-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

export type { SettingsView };

/** `reviews.view-reviews-settings`: an admin reads the reviews state of the Market (default off). */
export class ViewReviewsSettings extends UseCase<
  Record<string, never>,
  SettingsView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.view-reviews-settings',
    rule: { kind: 'permissions', allOf: [REVIEWS_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context);
  }
}
