import { Module, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER } from '../../platform/audit/audit-writer';
import {
  registerPermissions,
  registerStepUpActions,
  STEP_UP_CONSUMER,
  USE_CASE_GATE,
  type UseCaseGate,
} from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { PricingModule } from '../pricing';
import { SellersModule } from '../sellers';
import { UNIT_OF_WORK } from '../../platform/unit-of-work/unit-of-work';
import { MARKET_SETTING_REPOSITORY } from './application/ports/market-setting.repository';
import { OPT_IN_REPOSITORY } from './application/ports/opt-in.repository';
import { PRICE_HISTORY } from './application/ports/price-history';
import { PROMOTION_REPOSITORY } from './application/ports/promotion.repository';
import { PROMOTIONS_POLICY } from './application/ports/promotions-policy';
import { REVIEW_QUEUE_REPOSITORY } from './application/ports/review-queue.repository';
import { SELLER_ACTIVITY } from './application/ports/seller-activity';
import {
  FIRST_ORDER_SETTINGS_REPOSITORY,
  SHIPPING_THRESHOLD_REPOSITORY,
} from './application/ports/settings.repository';
import type { PromotionsDependencies } from './application/promotions-dependencies';
import { CheckWasPrice } from './application/use-cases/check-was-price.use-case';
import { CreateOwnPromotion } from './application/use-cases/create-own-promotion.use-case';
import { CreatePromotion } from './application/use-cases/create-promotion.use-case';
import { DecidePromotionReview } from './application/use-cases/decide-promotion-review.use-case';
import { EditOwnPromotion } from './application/use-cases/edit-own-promotion.use-case';
import { EditPromotion } from './application/use-cases/edit-promotion.use-case';
import { ListFreeShippingThresholds } from './application/use-cases/list-free-shipping-thresholds.use-case';
import { ListOwnPromotions } from './application/use-cases/list-own-promotions.use-case';
import { ListPromotionReviews } from './application/use-cases/list-promotion-reviews.use-case';
import { ListPromotionsFull } from './application/use-cases/list-promotions-full.use-case';
import { ListPromotions } from './application/use-cases/list-promotions.use-case';
import { PauseOwnPromotion } from './application/use-cases/pause-own-promotion.use-case';
import { PausePromotion } from './application/use-cases/pause-promotion.use-case';
import { PreviewQuote } from './application/use-cases/preview-quote.use-case';
import { QuoteDiscounts } from './application/use-cases/quote-discounts.use-case';
import { ResumeOwnPromotion } from './application/use-cases/resume-own-promotion.use-case';
import { ResumePromotion } from './application/use-cases/resume-promotion.use-case';
import { SetCoFundingOptIn } from './application/use-cases/set-co-funding-opt-in.use-case';
import { SetFirstOrderSettings } from './application/use-cases/set-first-order-settings.use-case';
import { SetFreeShippingThreshold } from './application/use-cases/set-free-shipping-threshold.use-case';
import { SetPromotionBudget } from './application/use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from './application/use-cases/set-promotions-status.use-case';
import { ViewFirstOrderSettings } from './application/use-cases/view-first-order-settings.use-case';
import { ViewPromotion } from './application/use-cases/view-promotion.use-case';
import { ViewPromotionsSettings } from './application/use-cases/view-promotions-settings.use-case';
import {
  PROMOTIONS_AUDIT_ACTIONS,
  PROMOTIONS_FACADE,
  PROMOTIONS_PERMISSIONS,
  PROMOTIONS_STEP_UP_ACTIONS,
} from './contracts';
import { promotionsProviders } from './infrastructure/promotions-providers';
import {
  AdminPromotionsController,
  SellerPromotionsController,
} from './presentation/promotions.controller';
import { PromotionsFacadeImplementation } from './presentation/promotions.facade';

type UseCaseClass<U> = new (gate: UseCaseGate, deps: PromotionsDependencies) => U;

const PORTS: readonly [keyof PromotionsDependencies, InjectionToken][] = [
  ['unitOfWork', UNIT_OF_WORK],
  ['promotions', PROMOTION_REPOSITORY],
  ['optIns', OPT_IN_REPOSITORY],
  ['reviews', REVIEW_QUEUE_REPOSITORY],
  ['settings', MARKET_SETTING_REPOSITORY],
  ['firstOrder', FIRST_ORDER_SETTINGS_REPOSITORY],
  ['thresholds', SHIPPING_THRESHOLD_REPOSITORY],
  ['policy', PROMOTIONS_POLICY],
  ['sellerActivity', SELLER_ACTIVITY],
  ['priceHistory', PRICE_HISTORY],
  ['stepUp', STEP_UP_CONSUMER],
  ['audit', AUDIT_WRITER],
  ['ids', ID_GENERATOR],
  ['clock', CLOCK],
];

/** Every promotions use case shares one dependency object, built from the same ports. */
function useCaseProvider<U>(type: UseCaseClass<U>): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, ...PORTS.map(([, token]) => token)],
    useFactory: (gate: UseCaseGate, ...values: unknown[]) =>
      new type(
        gate,
        Object.fromEntries(
          PORTS.map(([name], index) => [name, values[index]]),
        ) as unknown as PromotionsDependencies,
      ),
  };
}

/**
 * Promotions (package T1): the discount domain and the pure calculation, the admin and seller
 * use cases, the review queue and the per-Market switch (off by default), in the `promotions`
 * schema. Other modules reach it through `PROMOTIONS_FACADE` only. The seller's age and the
 * was-price history are read through the sellers and pricing facades. Checkout integration, budget
 * reservation, the ledger and refunds come in later packages.
 */
@Module({
  imports: [PricingModule, SellersModule],
  controllers: [AdminPromotionsController, SellerPromotionsController],
  providers: [
    PersistenceModule.auditWriterFor('promotions'),
    registerAuditActions('promotions', PROMOTIONS_AUDIT_ACTIONS),
    registerPermissions('promotions', PROMOTIONS_PERMISSIONS),
    registerStepUpActions('promotions', PROMOTIONS_STEP_UP_ACTIONS),
    ...promotionsProviders,
    ...[
      ViewPromotionsSettings,
      SetPromotionsStatus,
      ListPromotions,
      ListPromotionsFull,
      ViewPromotion,
      CreatePromotion,
      EditPromotion,
      PausePromotion,
      ResumePromotion,
      SetPromotionBudget,
      ListPromotionReviews,
      DecidePromotionReview,
      ViewFirstOrderSettings,
      SetFirstOrderSettings,
      ListFreeShippingThresholds,
      SetFreeShippingThreshold,
      PreviewQuote,
      CreateOwnPromotion,
      EditOwnPromotion,
      PauseOwnPromotion,
      ResumeOwnPromotion,
      ListOwnPromotions,
      SetCoFundingOptIn,
      QuoteDiscounts,
      CheckWasPrice,
    ].map((type) => useCaseProvider(type as UseCaseClass<unknown>)),
    {
      provide: PROMOTIONS_FACADE,
      inject: [QuoteDiscounts, CheckWasPrice],
      useFactory: (quote: QuoteDiscounts, wasPrice: CheckWasPrice) =>
        new PromotionsFacadeImplementation(quote, wasPrice),
    },
  ],
  exports: [PROMOTIONS_FACADE],
})
export class PromotionsModule {}
