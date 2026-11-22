import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  MAX_REPORT_FACTS,
  type ReportingReadFailure,
  type SellerOrderReportFacts,
} from '../../contracts/ordering-reporting.facade';
import { sellerOrderReportFacts } from '../report-facts';
import type { OrderingDependencies } from '../checkout-flow';

interface SellerOrderReportFactsInput {
  readonly sellerOrders: readonly {
    readonly orderId: string;
    readonly sellerOrderId: string | null;
  }[];
}

/**
 * `ordering.seller-order-report-facts`: the facts of the seller orders asked for, for reporting
 * (dashboards upgrade phase 3). Rule `system`. Ids and money only. An unknown seller order, one of
 * another Market or not of the named order is absent. The request is checked whole before any read.
 */
export class SellerOrderReportFactsQuery extends UseCase<
  SellerOrderReportFactsInput,
  readonly SellerOrderReportFacts[],
  ReportingReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-order-report-facts',
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
    input: SellerOrderReportFactsInput,
  ): Promise<Result<readonly SellerOrderReportFacts[], ReportingReadFailure>> {
    const refs: readonly unknown[] | null = Array.isArray(input?.sellerOrders)
      ? (input.sellerOrders as readonly unknown[])
      : null;
    if (refs === null || refs.length > MAX_REPORT_FACTS) return err({ code: 'validation.failed' });
    const text = (ref: unknown, key: 'orderId' | 'sellerOrderId'): string => {
      const value =
        typeof ref === 'object' && ref !== null ? (ref as Record<string, unknown>)[key] : null;
      return typeof value === 'string' ? value : '';
    };
    // An order id with a null seller order asks for every seller order of the order (the
    // cancellation event names the order only).
    const wanted = new Map<Id<'Order'>, Set<Id<'SellerOrder'>> | 'all'>();
    for (const ref of refs) {
      const orderId = parseId<'Order'>(text(ref, 'orderId'));
      if (!orderId.ok) return err({ code: 'validation.failed' });
      const whole =
        typeof ref === 'object' &&
        ref !== null &&
        (ref as Record<string, unknown>).sellerOrderId === null;
      if (whole) {
        wanted.set(orderId.value, 'all');
        continue;
      }
      const sellerOrderId = parseId<'SellerOrder'>(text(ref, 'sellerOrderId'));
      if (!sellerOrderId.ok) return err({ code: 'validation.failed' });
      const known = wanted.get(orderId.value);
      if (known === 'all') continue;
      const set = known ?? new Set<Id<'SellerOrder'>>();
      set.add(sellerOrderId.value);
      wanted.set(orderId.value, set);
    }
    if (wanted.size === 0) return ok([]);
    return this.deps.unitOfWork.run<readonly SellerOrderReportFacts[], ReportingReadFailure>(
      context.market,
      async () => {
        const now = this.deps.clock.now();
        const facts: SellerOrderReportFacts[] = [];
        for (const [orderId, sellerOrderIds] of wanted) {
          const order = await this.deps.orders.findById(context.market, orderId);
          if (order === null) continue;
          for (const sellerOrder of order.sellerOrders) {
            if (sellerOrderIds === 'all' || sellerOrderIds.has(sellerOrder.id)) {
              facts.push(sellerOrderReportFacts(order, sellerOrder, now));
            }
          }
        }
        return ok(facts);
      },
      { readOnly: true },
    );
  }
}
