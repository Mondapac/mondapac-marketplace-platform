import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SETTINGS_MANAGE } from '../../contracts/permissions';
import { setStatus, type SettingsFailure, type SettingsView } from '../settings-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

interface Input {
  readonly status?: unknown;
}

/**
 * `reviews.set-reviews-status`: an admin moves the Market's reviews between off and active
 * (protected key). Refused in acting-as, audited, idempotent.
 */
export class SetReviewsStatus extends UseCase<Input, SettingsView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.set-reviews-status',
    rule: { kind: 'permissions', allOf: [REVIEWS_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setStatus(this.deps, context, input);
  }
}
