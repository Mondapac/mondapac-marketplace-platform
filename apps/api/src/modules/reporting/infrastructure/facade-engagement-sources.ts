import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { EngagementFacade } from '../../engagement';
import type { OrderingReportingFacade } from '../../ordering';
import type {
  EngagementSources,
  FunnelCounts,
  FunnelUnavailable,
} from '../application/ports/engagement-sources';

/**
 * {@link EngagementSources} on ordering's `checkoutsStarted` and engagement's `shoppingFunnel`.
 * The checkouts (account ids) go from one facade to the other unchanged within this call: never
 * stored, logged or returned (Hassan's rules for the funnel, dashboards v2 phase 2).
 */
export class FacadeEngagementSources implements EngagementSources {
  constructor(
    private readonly ordering: Pick<OrderingReportingFacade, 'checkoutsStarted'>,
    private readonly engagement: Pick<EngagementFacade, 'shoppingFunnel'>,
  ) {}

  async funnelOf(
    context: CallContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
  ): Promise<Result<FunnelCounts, FunnelUnavailable>> {
    const checkouts = await this.ordering.checkoutsStarted(context, { window });
    if (!checkouts.ok) return err({ code: `ordering:${checkouts.error.code}` });
    if (!checkouts.value.complete) return err({ code: 'ordering:too-many-checkouts' });
    const counts = await this.engagement.shoppingFunnel(context, {
      window,
      checkouts: checkouts.value.items,
    });
    if (!counts.ok) return err({ code: `engagement:${counts.error.code}` });
    const { viewed, carted, checkedOut, paid } = counts.value;
    return ok({ viewed, carted, checkedOut, paid });
  }
}
