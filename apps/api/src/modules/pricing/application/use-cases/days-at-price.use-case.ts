import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PricingValidationFailed } from '../../contracts/pricing.facade';
import {
  readDaysAtPrice,
  type DaysAtPriceDependencies,
  type DaysAtPriceInput,
} from '../prices/read-days-at-price';

export type { DaysAtPriceInput } from '../prices/read-days-at-price';

/**
 * `daysAtPrice` for request actors (the product page's was-price check): rule `anonymous`, as
 * for effective prices: the answer is about prices buyers already saw.
 */
export class DaysAtPriceQuery extends UseCase<
  DaysAtPriceInput,
  number | null,
  PricingValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.days-at-price',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DaysAtPriceDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: DaysAtPriceInput) {
    return readDaysAtPrice(this.deps, context, input);
  }
}
