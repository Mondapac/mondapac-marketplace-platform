import type { CallContext } from '@mondapac/shared-kernel';
import type { SumDiscountCost } from '../application/use-cases/sum-discount-cost.use-case';
import type { DiscountCostRequest, PromotionsReportingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class PromotionsReportingFacadeImplementation implements PromotionsReportingFacade {
  constructor(private readonly sumDiscountCost: SumDiscountCost) {}

  discountCost(context: CallContext, request: DiscountCostRequest) {
    return this.sumDiscountCost.execute(context, request);
  }
}
