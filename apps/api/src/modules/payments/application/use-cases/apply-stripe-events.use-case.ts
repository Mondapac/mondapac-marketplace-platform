import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { applyStripeEvents, type ApplyFailure, type ApplySummary } from '../apply-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

/**
 * Applies the stored Stripe events of one Market through ordering's confirm and cancel. Rule
 * `system`: only the worker's job calls it.
 */
export class ApplyStripeEvents extends UseCase<Record<string, never>, ApplySummary, ApplyFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.apply-stripe-events',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return applyStripeEvents(this.deps, context);
  }
}
