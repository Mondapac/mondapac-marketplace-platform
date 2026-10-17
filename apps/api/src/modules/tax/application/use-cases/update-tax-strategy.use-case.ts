import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TAX_STRATEGY_MANAGE } from '../../contracts/permissions';
import type { TaxDependencies } from '../tax-dependencies';
import { updateStrategy, type StrategyFailure, type StrategyView } from '../strategy-flow';

/** `tax.update-tax-strategy`: An admin changes a tax strategy (protected key). */
export class UpdateTaxStrategy extends UseCase<
  { readonly strategyId: unknown; readonly body: unknown },
  StrategyView,
  StrategyFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.update-tax-strategy',
    rule: { kind: 'permissions', allOf: [TAX_STRATEGY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly strategyId: unknown; readonly body: unknown },
  ) {
    return updateStrategy(this.deps, context, input);
  }
}
