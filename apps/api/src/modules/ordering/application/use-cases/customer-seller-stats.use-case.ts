import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CustomerOrderStatsFailure, CustomerSellerStats } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * `customer-seller-stats`: what one customer's confirmed orders add up to with each seller, for
 * `customers`' per-seller read model (customers management phase 3). Rule `system`. Counts,
 * instants and amounts only; spent is the gross less the refunds that succeeded, never below zero.
 */
export class CustomerSellerStatsQuery extends UseCase<
  { readonly accountId: string },
  readonly CustomerSellerStats[],
  CustomerOrderStatsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.customer-seller-stats',
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
  ): Promise<Result<readonly CustomerSellerStats[], CustomerOrderStatsFailure>> {
    const parsed =
      typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
    const accountId = parsed.value;
    return this.deps.unitOfWork.run<readonly CustomerSellerStats[], CustomerOrderStatsFailure>(
      context.market,
      async () => {
        const rows = await this.deps.orders.sellerTotalsOf(context.market, accountId);
        return ok(
          rows.map((row) => {
            const net = row.grossMinor - row.refundedMinor;
            return {
              sellerId: row.sellerId,
              orderCount: row.orderCount,
              firstOrderAt: row.firstConfirmedAt,
              lastOrderAt: row.lastConfirmedAt,
              spentMinor: net > 0n ? net : 0n,
              currency: row.currency,
            };
          }),
        );
      },
      { readOnly: true },
    );
  }
}
