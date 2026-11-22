import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountLateDeliveries } from '../application/use-cases/count-late-deliveries.use-case';
import type { CountPendingRefunds } from '../application/use-cases/count-pending-refunds.use-case';
import type { CountFailedPayments } from '../application/use-cases/count-failed-payments.use-case';
import type { CountSellerLateOrders } from '../application/use-cases/count-seller-late-orders.use-case';
import type { CountSellerPickupsUncollected } from '../application/use-cases/count-seller-pickups-uncollected.use-case';
import type { CountSellerToShipToday } from '../application/use-cases/count-seller-to-ship-today.use-case';
import type { OrderingWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class OrderingWorkQueueFacadeImplementation implements OrderingWorkQueueFacade {
  constructor(
    private readonly late: CountLateDeliveries,
    private readonly refunds: CountPendingRefunds,
    private readonly failed: CountFailedPayments,
    private readonly sellerLate: CountSellerLateOrders,
    private readonly sellerToShip: CountSellerToShipToday,
    private readonly sellerPickups: CountSellerPickupsUncollected,
  ) {}

  lateDeliveries(context: CallContext, query: WorkQueueCountQuery) {
    return this.late.execute(context, query);
  }

  pendingRefunds(context: CallContext, query: WorkQueueCountQuery) {
    return this.refunds.execute(context, query);
  }

  failedPayments(context: CallContext, query: WorkQueueCountQuery) {
    return this.failed.execute(context, query);
  }

  sellerLateOrders(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerLate.execute(context, query);
  }

  sellerToShipToday(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerToShip.execute(context, query);
  }

  sellerPickupsUncollected(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerPickups.execute(context, query);
  }
}
