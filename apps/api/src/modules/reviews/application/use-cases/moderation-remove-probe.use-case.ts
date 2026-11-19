import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_REMOVE } from '../../contracts/permissions';

/**
 * `reviews.moderation-remove-probe`: asks the gate whether the caller holds
 * `reviews.moderation.remove`. It reads and writes nothing. The moderation list calls it to name the
 * row actions the caller may run; `access.denied` means "no". Each action's own use case checks
 * its key, the review's state and the two-step proof again when it runs.
 */
export class ModerationRemoveProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.moderation-remove-probe',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_REMOVE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
