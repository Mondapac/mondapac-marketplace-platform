import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { detachAuthor, type MaintenanceFailure } from '../maintenance-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

interface Input {
  readonly accountId?: unknown;
}

/**
 * `reviews.detach-author`: a deleted account's reviews and ratings lose their author link and
 * stay as "Former customer" (rule `system`; owner decision N11). Called through the reviews
 * facade; identity's account deletion is not wired to it yet (it has no deletion event today).
 */
export class DetachAuthor extends UseCase<
  Input,
  { readonly reviews: number; readonly ratings: number },
  MaintenanceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.detach-author',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return detachAuthor(this.deps, context, input);
  }
}
