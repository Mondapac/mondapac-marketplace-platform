import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import {
  recentViewsOfCustomer,
  type RecentViewsFailure,
  type RecentViewsInput,
} from '../engagement-flow';
import type { RecentViews } from '../ports/behaviour-event.repository';

/**
 * `engagement.recent-views`: a signed-in customer's recently viewed product and category ids,
 * for the recommendations (rule `own-resources`). Empty under Global Privacy Control or with the
 * customer's personalization switch off.
 */
export class RecentViewsOfCustomer extends UseCase<
  RecentViewsInput,
  RecentViews,
  RecentViewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.recent-views',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecentViewsInput) {
    return recentViewsOfCustomer(this.deps, context, input);
  }
}
