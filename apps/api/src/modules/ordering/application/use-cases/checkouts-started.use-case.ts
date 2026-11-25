import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  MAX_REPORT_CHECKOUT_WINDOW_HOURS,
  MAX_REPORT_CHECKOUTS,
  type ReportCheckouts,
  type ReportingReadFailure,
} from '../../contracts/ordering-reporting.facade';
import type { ReportingChangesDependencies } from '../reporting-changes';

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

interface CheckoutsStartedInput {
  readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
}

/**
 * `ordering.checkouts-started` (dashboards v2, phase 2): the accounts that placed an order in a
 * window of at most 26 hours (one Market day), each once with whether one of those orders was
 * paid, for reporting's nightly shopping-funnel snapshot, which hands them unchanged to
 * engagement. "Started checkout" is an order created: there is no checkout event (phase plan).
 * Rule `system`. A window with more than {@link MAX_REPORT_CHECKOUTS} accounts answers the first
 * ones with `complete: false`, so the caller never records a short count. One read-only unit.
 */
export class CheckoutsStartedQuery extends UseCase<
  CheckoutsStartedInput,
  ReportCheckouts,
  ReportingReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.checkouts-started',
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
    input: CheckoutsStartedInput,
  ): Promise<Result<ReportCheckouts, ReportingReadFailure>> {
    const window = input?.window;
    if (!isInstant(window?.from) || !isInstant(window.to)) {
      return err({ code: 'validation.failed' });
    }
    const span = window.to.epochMilliseconds - window.from.epochMilliseconds;
    if (!(span > 0) || span > MAX_REPORT_CHECKOUT_WINDOW_HOURS * 3_600_000) {
      return err({ code: 'validation.failed' });
    }
    return this.deps.unitOfWork.run<ReportCheckouts, ReportingReadFailure>(
      context.market,
      async () => {
        const rows = await this.deps.changes.checkoutsStarted(
          context.market,
          window,
          MAX_REPORT_CHECKOUTS + 1,
        );
        return ok({
          items: rows.slice(0, MAX_REPORT_CHECKOUTS),
          complete: rows.length <= MAX_REPORT_CHECKOUTS,
        });
      },
      { readOnly: true },
    );
  }
}
