import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { settleRefunds, type RefundSettling } from '../refund-flow';

/**
 * Retries refunds whose Stripe answer is unknown, with their stored keys. Rule `system`: only the
 * worker's job `ordering.settle-refunds` calls it.
 */
export class SettleRefunds extends UseCase<Record<string, never>, RefundSettling, never> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.settle-refunds',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return settleRefunds(this.deps, context);
  }
}
