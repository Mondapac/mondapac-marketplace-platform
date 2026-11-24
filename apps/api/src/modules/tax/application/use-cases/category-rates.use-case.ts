import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CategoryRatesAnswer, TaxFailure } from '../../contracts/tax.facade';
import { categoryRates } from '../calculate-flow';
import type { TaxDependencies } from '../tax-dependencies';

/**
 * `tax.category-rates`: the rate of each tax category code under the Market's strategy in force,
 * for the signed-in customer or approved seller (own resources: it reads no one's records, only
 * the Market's rates). For `promotions`' seller payout preview; not exposed over HTTP.
 */
export class CategoryRates extends UseCase<
  { readonly codes: unknown },
  CategoryRatesAnswer,
  TaxFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.category-rates',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly codes: unknown }) {
    return categoryRates(this.deps, context, input);
  }
}
