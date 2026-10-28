import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { PAYMENTS_FACADE, PaymentsModule, type PaymentsFacade } from '../payments';
import { DISPUTE_SOURCE, ORDER_PAYMENT_LOOKUP } from './application/ports/dispute-source';
import { SyncDispute } from './application/use-cases/sync-dispute.use-case';
import { CommissionPayoutsModule } from './commission-payouts.module';
import type {
  LateBoundDisputeSource,
  LateBoundOrderPaymentLookup,
} from './infrastructure/late-bound-dispute-ports';
import { OrderingOrderPaymentLookup } from './infrastructure/ordering-order-payment-lookup';
import { PaymentsDisputeSource } from './infrastructure/payments-dispute-source';
import { disputeSubscriptions } from './presentation/subscribers/dispute.subscriptions';

/**
 * Binds the dispute consumer of commission-payouts to payments and ordering (package 8b). It is a
 * module of its own because payments imports ordering and ordering imports commission-payouts:
 * `CommissionPayoutsModule` provides its two read ports refusing until this module binds the real
 * ones at start, and registers nothing from payments; this module (which imports all three) holds
 * the subscription to payments' event and is registered beside them in `modules/index.ts`. It is
 * not exported from the commission-payouts entry point, so no file cycle forms.
 */
@Module({
  imports: [CommissionPayoutsModule, PaymentsModule, OrderingModule],
  providers: [
    registerSubscriptionsFrom('commission-payouts', [SyncDispute], (sync: SyncDispute) =>
      disputeSubscriptions(sync),
    ),
  ],
})
export class CommissionPayoutsDisputesModule implements OnModuleInit {
  constructor(
    @Inject(DISPUTE_SOURCE) private readonly source: LateBoundDisputeSource,
    @Inject(ORDER_PAYMENT_LOOKUP) private readonly orders: LateBoundOrderPaymentLookup,
    @Inject(PAYMENTS_FACADE) private readonly payments: PaymentsFacade,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
  ) {}

  onModuleInit(): void {
    this.source.bind(new PaymentsDisputeSource(this.payments));
    this.orders.bind(new OrderingOrderPaymentLookup(this.ordering));
  }
}
