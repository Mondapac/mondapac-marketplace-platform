import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EffectivePriceMap } from '../../contracts/pricing.facade';
import {
  readEffectivePrices,
  type EffectivePricesDependencies,
  type EffectivePricesFailure,
  type EffectivePricesInput,
} from '../prices/read-effective-prices';

/** The same read for event handlers and jobs: rule `system`. */
export class EffectivePricesSystemQuery extends UseCase<
  EffectivePricesInput,
  EffectivePriceMap,
  EffectivePricesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.effective-prices-system',
    rule: { kind: 'system' },
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
