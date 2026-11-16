import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CustomerOrderStats, CustomerOrderStatsFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * `customer-order-stats`: what one customer's confirmed orders and succeeded refunds add up to,
 * for the `customers` read model. Rule `system`. Amounts and instants only: no name, address or
 * email. An account with no confirmed order answers zero counts and null instants.
 */
export class CustomerOrderStatsQuery extends UseCase<
  { readonly accountId: string },
  CustomerOrderStats,
  CustomerOrderStatsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.customer-order-stats',
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
    input: { readonly accountId: string },
  ): Promise<Result<CustomerOrderStats, CustomerOrderStatsFailure>> {
    const parsed =
      typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
    const accountId = parsed.value;
    return this.deps.unitOfWork.run<CustomerOrderStats, CustomerOrderStatsFailure>(
      context.market,
      async () => {
        const totals = await this.deps.orders.totalsOf(context.market, accountId);
        return ok({
          accountId,
          orderCount: totals.orderCount,
          firstOrderAt: totals.firstConfirmedAt,
          lastOrderAt: totals.lastConfirmedAt,
          spentMinor: totals.spentMinor,
          currency: totals.currency,
          refundCount: totals.refundCount,
          refundedMinor: totals.refundedMinor,
        });
      },
      { readOnly: true },
    );
  }
}
