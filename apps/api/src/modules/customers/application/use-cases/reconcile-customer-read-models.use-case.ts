import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  reconcileReadModels,
  type ReadModelFailure,
  type ReconcileCounts,
} from '../customer-read-model-flow';
import type { ReadModelDependencies } from '../read-model-dependencies';

/**
 * `customers.reconcile-read-models`: the one-off backfill and the nightly reconcile (job
 * `customers.reconcile-read-models`). Rule `system`. Safe to run twice and concurrently.
 */
export class ReconcileCustomerReadModels extends UseCase<
  Record<string, never>,
  ReconcileCounts,
  ReadModelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.reconcile-customer-read-models',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReadModelDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<ReconcileCounts, ReadModelFailure>> {
    return reconcileReadModels(this.deps, context);
  }
}
