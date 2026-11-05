import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_QUEUE } from '../../contracts/permissions';
import {
  listModerationQueue,
  type ModerationQueuePage,
  type ModerationFailure,
  type ListQueueInput,
} from '../moderation-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

export type { ModerationQueuePage, ModerationReviewView } from '../moderation-flow';

/** `reviews.list-moderation-queue`: The moderator queue: held, reported and actioned reviews with counts per tab. Needs `reviews.moderation.queue`. */
export class ListModerationQueue extends UseCase<
  ListQueueInput,
  ModerationQueuePage,
  ModerationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.list-moderation-queue',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_QUEUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ListQueueInput) {
    return listModerationQueue(this.deps, context, input);
  }
}
