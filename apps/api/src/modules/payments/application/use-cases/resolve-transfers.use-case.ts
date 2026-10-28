import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaymentsDependencies } from '../payments-dependencies';
import { resolveTransfers, type ResolveFailure, type ResolveSummary } from '../transfer-flow';

/**
 * `payments.resolve-transfers`: looks up the sends that never got an answer, at Stripe by their
 * keys, and records the ones found. Rule `system`: only the worker's job calls it.
 */
export class ResolveTransfers extends UseCase<
  Record<string, never>,
  ResolveSummary,
  ResolveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.resolve-transfers',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return resolveTransfers(this.deps, context);
  }
}
