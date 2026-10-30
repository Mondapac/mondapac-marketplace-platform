import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PricingValidationFailed } from '../../contracts/pricing.facade';
import {
  readDaysAtPrice,
  type DaysAtPriceDependencies,
  type DaysAtPriceInput,
} from '../prices/read-days-at-price';

/** The same read for event handlers and jobs: rule `system`. */
export class DaysAtPriceSystemQuery extends UseCase<
  DaysAtPriceInput,
  number | null,
  PricingValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.days-at-price-system',
    rule: { kind: 'system' },
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
