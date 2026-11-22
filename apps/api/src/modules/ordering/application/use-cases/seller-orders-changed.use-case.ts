import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ReportChangesPage,
  ReportingReadFailure,
  SellerOrderRef,
} from '../../contracts/ordering-reporting.facade';
import {
  checkChanges,
  type ChangesInput,
  type ReportingChangesDependencies,
} from '../reporting-changes';

/**
 * `ordering.seller-orders-changed`: the seller orders whose payment, cancellation, ready,
 * shipment or delivery falls in a window, for reporting's nightly reconcile and history backfill
 * (dashboards upgrade phase 3). Rule `system`. Ids only.
 */
export class SellerOrdersChangedQuery extends UseCase<
  ChangesInput,
  ReportChangesPage<SellerOrderRef>,
  ReportingReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-orders-changed',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReportingChangesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangesInput,
  ): Promise<Result<ReportChangesPage<SellerOrderRef>, ReportingReadFailure>> {
    const request = checkChanges<'SellerOrder'>(input);
    if (request === null) return err({ code: 'validation.failed' });
    return this.deps.unitOfWork.run<ReportChangesPage<SellerOrderRef>, ReportingReadFailure>(
      context.market,
      async () =>
        ok(
          await this.deps.changes.sellerOrdersChanged(
            context.market,
            request.window,
            request.after,
            request.limit,
          ),
        ),
      { readOnly: true },
    );
  }
}
