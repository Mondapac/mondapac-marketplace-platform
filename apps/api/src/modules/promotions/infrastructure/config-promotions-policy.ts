import type { MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  FirstOrderSettings,
  PromotionsPolicy,
  PromotionsSettings,
} from '../application/ports/promotions-policy';

/** The Market's promotions settings from Market config; none configured means unavailable. */
export class ConfigPromotionsPolicy implements PromotionsPolicy {
  constructor(private readonly markets: MarketRegistry) {}

  settings(market: MarketContext): PromotionsSettings | null {
    const config = this.markets.get(market.marketId);
    const promotions = config.promotions;
    if (promotions === undefined) return null;
    const firstOrder = promotions.firstOrder;
    const defaults: FirstOrderSettings | null =
      firstOrder === undefined
        ? null
        : {
            enabled: firstOrder.enabled,
            kind: firstOrder.kind,
            percentBps: firstOrder.percentBps ?? null,
            amountMinor:
              firstOrder.amountMinor === undefined ? null : BigInt(firstOrder.amountMinor),
            capMinor: firstOrder.capMinor === undefined ? null : BigInt(firstOrder.capMinor),
            minSpendMinor: BigInt(firstOrder.minSpendMinor),
            monthlyBudgetMinor: BigInt(firstOrder.monthlyBudgetMinor),
          };
    return {
      currency: config.defaultCurrency,
      rules: {
        sellerMaxDiscountBps: promotions.sellerMaxDiscountBps,
        priorApprovalDiscountBps: promotions.priorApprovalDiscountBps,
        newSellerDays: promotions.newSellerDays,
        platformBudgetStepUpMinor: BigInt(promotions.platformBudgetStepUpMinor),
        gstRulingConfirmed: promotions.gstRulingConfirmed,
      },
      lineDiscountCapBps: promotions.lineDiscountCapBps,
      freeShippingThresholdMinor: BigInt(promotions.freeShippingThresholdMinor),
      maxActivePromotionsPerSeller: promotions.maxActivePromotionsPerSeller,
      wasPrice: promotions.wasPrice,
      firstOrderDefaults: defaults,
    };
  }
}
