import { Module } from '@nestjs/common';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { CashbackOnDelivery } from './application/use-cases/cashback-on-delivery.use-case';
import { ConfirmRedemptions } from './application/use-cases/confirm-redemptions.use-case';
import { QualifyReferralOnDelivery } from './application/use-cases/qualify-referral-on-delivery.use-case';
import { ReleaseCancelledRedemptions } from './application/use-cases/release-cancelled-redemptions.use-case';
import { PromotionsModule } from './promotions.module';
import { deliveryCreditSubscriptions } from './presentation/subscribers/delivery-credit.subscriptions';
import { redemptionSubscriptions } from './presentation/subscribers/redemption.subscriptions';

/**
 * Subscribes promotions to ordering's events. It is a module of its own because `ordering`
 * imports `promotions` (checkout prices and redeems discounts, package T2), and the subscriptions
 * need ordering's event definitions: kept out of `PromotionsModule` and the promotions entry
 * point, no file cycle forms. Registered in `BINDING_MODULES` in `modules/index.ts`.
 */
@Module({
  imports: [PromotionsModule],
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
export class PromotionsOrderEventsModule {}
