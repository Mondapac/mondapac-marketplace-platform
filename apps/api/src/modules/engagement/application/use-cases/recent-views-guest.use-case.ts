import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import {
  recentViewsOfGuest,
  type RecentViewsFailure,
  type RecentViewsInput,
} from '../engagement-flow';
import type { RecentViews } from '../ports/behaviour-event.repository';

/**
 * `engagement.recent-views-guest`: a guest's recently viewed product and category ids under the
 * engagement guest cookie (rule `anonymous`: no session). Empty without the guest's consent, under
 * Global Privacy Control or without a well-formed cookie. Sets no cookie.
 */
export class RecentViewsOfGuest extends UseCase<RecentViewsInput, RecentViews, RecentViewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.recent-views-guest',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecentViewsInput) {
    return recentViewsOfGuest(this.deps, context, input);
  }
}
