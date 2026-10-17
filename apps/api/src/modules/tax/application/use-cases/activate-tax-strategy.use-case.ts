import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TAX_STRATEGY_MANAGE } from '../../contracts/permissions';
import type { TaxDependencies } from '../tax-dependencies';
import { activateStrategy, type StrategyFailure, type StrategyListView } from '../strategy-flow';

/** `tax.activate-tax-strategy`: An admin picks the Market's active tax strategy (protected key). */
export class ActivateTaxStrategy extends UseCase<
  { readonly strategyId: unknown },
  StrategyListView,
  StrategyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.activate-tax-strategy',
    rule: { kind: 'permissions', allOf: [TAX_STRATEGY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly strategyId: unknown }) {
    return activateStrategy(this.deps, context, input);
  }
}
