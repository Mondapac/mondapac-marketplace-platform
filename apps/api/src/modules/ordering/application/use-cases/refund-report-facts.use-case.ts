import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  MAX_REPORT_FACTS,
  type RefundReportFacts,
  type ReportingReadFailure,
} from '../../contracts/ordering-reporting.facade';
import { refundReportFacts } from '../report-facts';
import type { OrderingDependencies } from '../checkout-flow';

interface RefundReportFactsInput {
  readonly refundIds: readonly string[];
}

/**
 * `ordering.refund-report-facts`: the facts of the refunds asked for that SUCCEEDED, for reporting
 * (dashboards upgrade phase 3). Rule `system`. A pending, failed, unknown or other Market's refund
 * is absent. The request is checked whole before any read.
 */
export class RefundReportFactsQuery extends UseCase<
  RefundReportFactsInput,
  readonly RefundReportFacts[],
  ReportingReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.refund-report-facts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RefundReportFactsInput,
  ): Promise<Result<readonly RefundReportFacts[], ReportingReadFailure>> {
    const raw = Array.isArray(input?.refundIds) ? input.refundIds : null;
    if (raw === null || raw.length > MAX_REPORT_FACTS) return err({ code: 'validation.failed' });
    const ids = new Set<Id<'Refund'>>();
    for (const text of raw) {
      const id = parseId<'Refund'>(typeof text === 'string' ? text : '');
      if (!id.ok) return err({ code: 'validation.failed' });
      ids.add(id.value);
    }
    if (ids.size === 0) return ok([]);
    return this.deps.unitOfWork.run<readonly RefundReportFacts[], ReportingReadFailure>(
      context.market,
      async () => {
        const facts: RefundReportFacts[] = [];
        for (const id of ids) {
          const refund = await this.deps.refunds.findById(context.market, id);
          if (refund === null) continue;
          const order = await this.deps.orders.findById(context.market, refund.orderId);
          if (order === null) continue;
          const fact = refundReportFacts(refund, order);
          if (fact !== null) facts.push(fact);
        }
        return ok(facts);
      },
      { readOnly: true },
    );
  }
}
