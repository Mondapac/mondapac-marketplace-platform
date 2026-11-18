import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReadModelFailure } from '../customer-read-model-flow';
import {
  reconcileSellerCustomers,
  type SellerCustomerDependencies,
  type SellerCustomerReconcileCounts,
} from '../seller-customers-flow';

/**
 * `customers.reconcile-seller-customers`: the backfill and the nightly reconcile of the per-seller
 * customers (job `customers.reconcile-seller-customers`). Rule `system`. Safe to run twice.
 */
export class ReconcileSellerCustomers extends UseCase<
  Record<string, never>,
  SellerCustomerReconcileCounts,
  ReadModelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.reconcile-seller-customers',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<SellerCustomerReconcileCounts, ReadModelFailure>> {
    return reconcileSellerCustomers(this.deps, context);
  }
}
