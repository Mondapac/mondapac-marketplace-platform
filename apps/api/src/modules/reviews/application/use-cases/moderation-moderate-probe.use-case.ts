import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_MODERATE } from '../../contracts/permissions';

/**
 * `reviews.moderation-moderate-probe`: asks the gate whether the caller holds
 * `reviews.moderation.moderate`. It reads and writes nothing. The moderation list calls it to name the
 * row actions the caller may run; `access.denied` means "no". Each action's own use case checks
 * its key, the review's state and the two-step proof again when it runs.
 */
export class ModerationModerateProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.moderation-moderate-probe',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_MODERATE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
