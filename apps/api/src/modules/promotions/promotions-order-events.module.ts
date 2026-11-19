import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { CashbackOnDelivery } from './application/use-cases/cashback-on-delivery.use-case';
import { ConfirmRedemptions } from './application/use-cases/confirm-redemptions.use-case';
import { QualifyReferralOnDelivery } from './application/use-cases/qualify-referral-on-delivery.use-case';
import { ReleaseCancelledRedemptions } from './application/use-cases/release-cancelled-redemptions.use-case';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { DELIVERED_ORDER_FACTS } from './application/ports/order-facts';
import { BoundDeliveredOrderFacts } from './infrastructure/bound-delivered-order-facts';
import { FacadeDeliveredOrderFacts } from './infrastructure/facade-delivered-order-facts';
import { PromotionsModule } from './promotions.module';
import { deliveryCreditSubscriptions } from './presentation/subscribers/delivery-credit.subscriptions';
import { redemptionSubscriptions } from './presentation/subscribers/redemption.subscriptions';

/**
 * Subscribes promotions to ordering's events. It is a module of its own because `ordering`
 * imports `promotions` (checkout prices and redeems discounts, package T2), and the subscriptions
 * need ordering's event definitions: kept out of `PromotionsModule` and the promotions entry
 * point, no file cycle forms. Registered in `BINDING_MODULES` in `modules/index.ts`. It also binds
 * ordering's facade as the reader of a delivered seller order's facts (customers phase 4c).
 */
@Module({
  imports: [PromotionsModule, OrderingModule],
  providers: [
    // Phase 3: cashback and the refer-a-friend reward, after `ordering.seller-order-delivered.v1`.
    registerSubscriptionsFrom(
      'promotions',
      [CashbackOnDelivery, QualifyReferralOnDelivery],
      (cashback: CashbackOnDelivery, referral: QualifyReferralOnDelivery) =>
        deliveryCreditSubscriptions(cashback, referral),
    ),
    // Package T2: an order's redemptions are confirmed when it is paid and released when it is
    // cancelled.
    registerSubscriptionsFrom(
      'promotions',
      [ConfirmRedemptions, ReleaseCancelledRedemptions],
      (confirm: ConfirmRedemptions, release: ReleaseCancelledRedemptions) =>
        redemptionSubscriptions(confirm, release),
    ),
  ],
})
export class PromotionsOrderEventsModule implements OnModuleInit {
  constructor(
    @Inject(DELIVERED_ORDER_FACTS) private readonly facts: BoundDeliveredOrderFacts,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
  ) {}

  /** Customers phase 4c: the delivery handlers read a seller order's facts from ordering. */
  onModuleInit(): void {
    this.facts.bind(new FacadeDeliveredOrderFacts(this.ordering));
  }
}
