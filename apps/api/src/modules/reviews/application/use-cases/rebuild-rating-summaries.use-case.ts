import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { rebuildSummaries, type MaintenanceFailure } from '../maintenance-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/**
 * `reviews.rebuild-rating-summaries`: the worker recomputes every product and seller summary of
 * the Market from the published source rows (rule `system`). The summary table is never the
 * source of truth: this is the repair for any drift. Does nothing while reviews are off.
 */
export class RebuildRatingSummaries extends UseCase<
  Record<string, never>,
  { readonly rebuilt: number },
  MaintenanceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.rebuild-rating-summaries',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return rebuildSummaries(this.deps, context);
  }
}
