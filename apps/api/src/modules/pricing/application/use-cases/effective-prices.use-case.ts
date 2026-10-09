import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EffectivePriceMap } from '../../contracts/pricing.facade';
import {
  readEffectivePrices,
  type EffectivePricesDependencies,
  type EffectivePricesFailure,
  type EffectivePricesInput,
} from '../prices/read-effective-prices';

export type { EffectivePricesInput } from '../prices/read-effective-prices';

/** `effectivePrices` for request actors (the cart, a storefront read): rule `anonymous`. */
export class EffectivePricesQuery extends UseCase<
  EffectivePricesInput,
  EffectivePriceMap,
  EffectivePricesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.effective-prices',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EffectivePricesDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: EffectivePricesInput) {
    return readEffectivePrices(this.deps, context, input);
  }
}
