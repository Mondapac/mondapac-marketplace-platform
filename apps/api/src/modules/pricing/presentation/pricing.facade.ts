import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { EffectivePricesSystemQuery } from '../application/use-cases/effective-prices-system.use-case';
import type { EffectivePricesQuery } from '../application/use-cases/effective-prices.use-case';
import type {
  EffectivePriceMap,
  PriceKey,
  PricingBatchTooLarge,
  PricingFacade,
  PricingValidationFailed,
} from '../contracts/pricing.facade';

export interface PricingFacadeUseCases {
  readonly effectivePrices: EffectivePricesQuery;
  readonly effectivePricesSystem: EffectivePricesSystemQuery;
}

/** Each method passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class PricingFacadeImplementation implements PricingFacade {
  constructor(private readonly useCases: PricingFacadeUseCases) {}

  effectivePrices(
    context: CallContext,
    keys: readonly PriceKey[],
  ): Promise<
    Result<EffectivePriceMap, AccessDenied | PricingValidationFailed | PricingBatchTooLarge>
  > {
    const useCase =
      context.actor.kind === 'system'
        ? this.useCases.effectivePricesSystem
        : this.useCases.effectivePrices;
    return useCase.execute(context, { keys });
  }
}
