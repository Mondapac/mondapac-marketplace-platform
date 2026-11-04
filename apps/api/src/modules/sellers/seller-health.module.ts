import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import {
  COMMISSION_PAYOUTS_FACADE,
  CommissionPayoutsModule,
  type CommissionPayoutsFacade,
} from '../commission-payouts';
import { ORDERING_FACADE, OrderingModule, type OrderingFacade } from '../ordering';
import { REVIEWS_FACADE, ReviewsModule, type ReviewsFacade } from '../reviews';
import { SELLER_HEALTH_SIGNALS } from './application/ports/seller-health-signals';
import { CommissionPayoutsSellerDisputeSignals } from './infrastructure/commission-payouts-seller-dispute-signals';
import { CompositeSellerHealthSignals } from './infrastructure/composite-seller-health-signals';
import type { LateBoundSellerHealthSignals } from './infrastructure/late-bound-seller-health-signals';
import { OrderingFacadeSellerOrderSignals } from './infrastructure/ordering-seller-order-signals';
import { ReviewsFacadeSellerReviewSignals } from './infrastructure/reviews-seller-review-signals';
import { SellersModule } from './sellers.module';

/**
 * Binds the three feeds of seller health (ordering, reviews, commission-payouts) to the nightly
 * run. A module of its own because those modules import sellers: `SellersModule` provides a
 * reader that refuses until this module binds the real one at start, and this module (which
 * imports all four) is registered beside them in `modules/index.ts`, like
 * `SellerStoreProfileModule`. Not exported from the sellers entry point, so no file cycle forms.
 */
@Module({ imports: [SellersModule, OrderingModule, ReviewsModule, CommissionPayoutsModule] })
export class SellerHealthModule implements OnModuleInit {
  constructor(
    @Inject(SELLER_HEALTH_SIGNALS) private readonly signals: LateBoundSellerHealthSignals,
    @Inject(ORDERING_FACADE) private readonly ordering: OrderingFacade,
    @Inject(REVIEWS_FACADE) private readonly reviews: ReviewsFacade,
    @Inject(COMMISSION_PAYOUTS_FACADE) private readonly commissionPayouts: CommissionPayoutsFacade,
  ) {}

  onModuleInit(): void {
    this.signals.bind(
      new CompositeSellerHealthSignals(
        new OrderingFacadeSellerOrderSignals(this.ordering),
        new ReviewsFacadeSellerReviewSignals(this.reviews),
        new CommissionPayoutsSellerDisputeSignals(this.commissionPayouts),
      ),
    );
  }
}
