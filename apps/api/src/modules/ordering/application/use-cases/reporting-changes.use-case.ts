import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_REPORT_CHANGES,
  type ReportChangesPage,
  type ReportingReadFailure,
  type ReportWindow,
  type SellerOrderRef,
} from '../../contracts/ordering-reporting.facade';
import type { ReportingChangesReader } from '../ports/reporting-changes.reader';

export interface ReportingChangesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly changes: ReportingChangesReader;
}

interface ChangesInput {
  readonly window: ReportWindow;
  readonly after: string | null;
  readonly limit: number;
}

type Checked<T extends string> = {
  readonly window: ReportWindow;
  readonly after: Id<T> | null;
  readonly limit: number;
};

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

/** The request checked whole: a window that runs forward, a well-formed cursor, a bounded page. */
function check<T extends string>(input: ChangesInput): Checked<T> | null {
  const window = input?.window;
  if (window === undefined || window === null || !isInstant(window.to)) return null;
  if (window.from !== null && !isInstant(window.from)) return null;
  if (window.from !== null && window.from.epochNanoseconds >= window.to.epochNanoseconds)
    return null;
  const limit = input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_CHANGES) return null;
  if (input.after === null) return { window, after: null, limit };
  const after = parseId<T>(typeof input.after === 'string' ? input.after : '');
  return after.ok ? { window, after: after.value, limit } : null;
}

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
    const request = check<'SellerOrder'>(input);
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
    const request = check<'Refund'>(input);
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
