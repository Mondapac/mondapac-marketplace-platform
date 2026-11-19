import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_QUEUE } from '../../contracts/permissions';
import {
  listModerationRows,
  type ModerationListDependencies,
  type ModerationListFailure,
  type ModerationListInput,
  type ModerationListPage,
} from '../moderation-list-flow';

export type { ModerationListPage } from '../moderation-list-flow';

/**
 * `reviews.query-moderation-reviews` (super list 18): an admin lists the reviews of the moderation
 * queue with views and counts, filters, sort, page numbers or Previous/Next and each row's actions.
 * Same key as the queue (`reviews.moderation.queue`); it reads the same reviews. Never the author.
 */
export class QueryModerationReviews extends UseCase<
  ModerationListInput,
  ModerationListPage,
  ModerationListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.query-moderation-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_QUEUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ModerationListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ModerationListInput) {
    return listModerationRows(this.deps, context, input);
  }
}
