import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { grantDueCredits, type CreditFlowFailure, type GrantDueReport } from '../credit-flow';
import type { PromotionsDependencies } from '../promotions-dependencies';

/**
 * `promotions.grant-due-credits`: the worker's grant of the cashback that waited for its seller
 * order's payout release (customers phase 4c). Rule `system` (the Market's system actor). Each
 * credit on its own: one that cannot be finished now is tried again on the next run.
 */
export class GrantDueCredits extends UseCase<void, GrantDueReport, CreditFlowFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.grant-due-credits',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<GrantDueReport, CreditFlowFailure>> {
    return grantDueCredits(this.deps, context);
  }
}
