import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TAX_STRATEGY_VIEW } from '../../contracts/permissions';
import type { TaxDependencies } from '../tax-dependencies';
import { listStrategies, type StrategyFailure, type StrategyListView } from '../strategy-flow';

export type { StrategyListView };

/** `tax.list-tax-strategies`: An admin reads the Market's tax strategies. */
export class ListTaxStrategies extends UseCase<
  Record<string, never>,
  StrategyListView,
  StrategyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.list-tax-strategies',
    rule: { kind: 'permissions', allOf: [TAX_STRATEGY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listStrategies(this.deps, context);
  }
}
