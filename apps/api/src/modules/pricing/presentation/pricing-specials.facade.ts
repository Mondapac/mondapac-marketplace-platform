import type { CallContext } from '@mondapac/shared-kernel';
import type { SpecialsInForceQuery } from '../application/use-cases/specials-in-force.use-case';
import type { PricingSpecialsFacade } from '../contracts/pricing-specials.facade';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class PricingSpecialsFacadeImplementation implements PricingSpecialsFacade {
  constructor(private readonly specials: SpecialsInForceQuery) {}

  specialsInForce(context: CallContext, request: { readonly limit: number }) {
    return this.specials.execute(context, request);
  }
}
