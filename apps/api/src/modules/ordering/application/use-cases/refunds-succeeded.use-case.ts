import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  ReportChangesPage,
  ReportingReadFailure,
} from '../../contracts/ordering-reporting.facade';
import {
  checkChanges,
  type ChangesInput,
  type ReportingChangesDependencies,
} from '../reporting-changes';

/**
 * `ordering.refunds-succeeded`: the refunds that succeeded in a window, for reporting's nightly
 * reconcile and history backfill. Rule `system`. Ids only.
 */
export class RefundsSucceededQuery extends UseCase<
  ChangesInput,
  ReportChangesPage<Id<'Refund'>>,
  ReportingReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.refunds-succeeded',
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
  ): Promise<Result<ReportChangesPage<Id<'Refund'>>, ReportingReadFailure>> {
    const request = checkChanges<'Refund'>(input);
    if (request === null) return err({ code: 'validation.failed' });
    return this.deps.unitOfWork.run<ReportChangesPage<Id<'Refund'>>, ReportingReadFailure>(
      context.market,
      async () =>
        ok(
          await this.deps.changes.refundsSucceeded(
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
