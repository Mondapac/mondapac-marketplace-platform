import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TAX_STRATEGY_MANAGE } from '../../contracts/permissions';
import type { TaxDependencies } from '../tax-dependencies';
import { deleteStrategy, type StrategyFailure } from '../strategy-flow';

/** `tax.delete-tax-strategy`: An admin removes an inactive tax strategy (protected key). */
export class DeleteTaxStrategy extends UseCase<
  { readonly strategyId: unknown },
  { readonly deleted: true },
  StrategyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.delete-tax-strategy',
    rule: { kind: 'permissions', allOf: [TAX_STRATEGY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly strategyId: unknown }) {
    return deleteStrategy(this.deps, context, input);
  }
}
