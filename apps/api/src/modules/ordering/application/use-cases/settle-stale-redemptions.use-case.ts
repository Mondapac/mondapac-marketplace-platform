import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { settleStaleRedemptions, type RedemptionSweep } from '../redemption-sweep';

/**
 * Settles the promotions redemptions that outlived their order's payment window (package T2).
 * Rule `system`: only the worker's job `ordering.settle-stale-redemptions` calls it.
 */
export class SettleStaleRedemptions extends UseCase<Record<string, never>, RedemptionSweep, never> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.settle-stale-redemptions',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return settleStaleRedemptions(this.deps, context);
  }
}
