import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { PAYMENTS_FACADE, PaymentsModule, type PaymentsFacade } from '../payments';
import { DISPUTE_SOURCE, ORDER_PAYMENT_LOOKUP } from './application/ports/dispute-source';
import { PAYMENTS_PAYOUTS } from './application/ports/payout-gateways';
import { ApplyTransferChange } from './application/use-cases/apply-transfer-change.use-case';
import { SyncDispute } from './application/use-cases/sync-dispute.use-case';
import { CommissionPayoutsModule } from './commission-payouts.module';
import type {
  LateBoundDisputeSource,
  LateBoundOrderPaymentLookup,
} from './infrastructure/late-bound-dispute-ports';
import type { LateBoundPaymentsPayouts } from './infrastructure/late-bound-payments-payouts';
import { OrderingOrderPaymentLookup } from './infrastructure/ordering-order-payment-lookup';
import { PaymentsFacadePayouts } from './infrastructure/payments-payouts';
import { PaymentsDisputeSource } from './infrastructure/payments-dispute-source';
import { disputeSubscriptions } from './presentation/subscribers/dispute.subscriptions';
import { transferSubscriptions } from './presentation/subscribers/transfer.subscriptions';

/**
 * Binds the dispute consumer of commission-payouts to payments and ordering (package 8b), and the
 * payout run's calls and consumer to payments (package 6d). It is a
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
    // Package 6d: payments' transfer-changed event settles the payout it belongs to.
    registerSubscriptionsFrom(
      'commission-payouts',
      [ApplyTransferChange],
      (apply: ApplyTransferChange) => transferSubscriptions(apply),
    ),
  ],
})
export class CommissionPayoutsDisputesModule implements OnModuleInit {
  constructor(
    @Inject(DISPUTE_SOURCE) private readonly source: LateBoundDisputeSource,
    @Inject(ORDER_PAYMENT_LOOKUP) private readonly orders: LateBoundOrderPaymentLookup,
    @Inject(PAYMENTS_PAYOUTS) private readonly payouts: LateBoundPaymentsPayouts,
    @Inject(PAYMENTS_FACADE) private readonly payments: PaymentsFacade,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
  ) {}

  onModuleInit(): void {
    this.source.bind(new PaymentsDisputeSource(this.payments));
    this.orders.bind(new OrderingOrderPaymentLookup(this.ordering));
    this.payouts.bind(new PaymentsFacadePayouts(this.payments));
  }
}
