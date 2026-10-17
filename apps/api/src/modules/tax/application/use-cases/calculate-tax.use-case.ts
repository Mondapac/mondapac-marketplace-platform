import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { TaxAnswer, TaxFailure } from '../../contracts/tax.facade';
import { calculateTax } from '../calculate-flow';
import type { TaxDependencies } from '../tax-dependencies';

/**
 * `tax.calculate-tax`: the tax of order lines under the Market's strategy in force, for `ordering`
 * to freeze on the order at checkout (called with the signed-in customer's context). The method
 * is not exposed over HTTP.
 */
export class CalculateTax extends UseCase<{ readonly lines: unknown }, TaxAnswer, TaxFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.calculate-tax',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly lines: unknown }) {
    return calculateTax(this.deps, context, input);
  }
}
