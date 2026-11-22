import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countSellerWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { SellerZones } from '../ports/seller-zones';
import type { WorkQueueCountReader } from '../ports/work-queue-count.reader';

export interface CountSellerToShipTodayDependencies extends WorkQueueCountDependencies<WorkQueueCountReader> {
  readonly zones: SellerZones;
}

/** The local day of `now` in `zone`: its first instant, and the first instant of the next day. */
export function localDayOf(
  now: Temporal.Instant,
  zone: string,
): { readonly start: Temporal.Instant; readonly end: Temporal.Instant } {
  const local = now.toZonedDateTimeISO(zone);
  return {
    start: local.startOfDay().toInstant(),
    end: local.add({ days: 1 }).startOfDay().toInstant(),
  };
}

/**
 * `ordering.count-seller-to-ship-today` (dashboards upgrade, phase 1, seller tasks): the seller's
 * own paid orders still to get ready whose ready-by time or scheduled window start falls on the
 * seller's local day and that are not late (the rule is documented on the reader). The day is the
 * seller's (ADR-0005): its approved operating zone, or the Market's zone before it has one, read
 * before the unit. Rule: the key `ordering.seller-order.view`, the session's own seller only,
 * denied while the seller is not approved. One read-only unit.
 */
export class CountSellerToShipToday extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.count-seller-to-ship-today',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CountSellerToShipTodayDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countSellerWorkQueue(
      this.deps,
      context,
      query,
      (counts, sellerId, day: { start: Temporal.Instant; end: Temporal.Instant }) =>
        counts.sellerToShipToday(
          context.market,
          sellerId,
          query.now,
          day.start,
          day.end,
          query.signal,
        ),
      async (sellerId) => localDayOf(query.now, await this.deps.zones.zoneOf(context, sellerId)),
    );
  }
}
