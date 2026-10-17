import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { TAX_STRATEGY_MANAGE } from '../../contracts/permissions';
import type { TaxDependencies } from '../tax-dependencies';
import { createStrategy, type StrategyFailure, type StrategyView } from '../strategy-flow';

export type { StrategyView };

/** `tax.create-tax-strategy`: An admin defines a tax strategy (protected key). */
export class CreateTaxStrategy extends UseCase<unknown, StrategyView, StrategyFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tax.create-tax-strategy',
    rule: { kind: 'permissions', allOf: [TAX_STRATEGY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TaxDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return createStrategy(this.deps, context, input);
  }
}
