import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { DeliveredSellerOrderFacts, DeliveredSellerOrderFactsFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

interface DeliveredSellerOrderFactsInput {
  readonly orderId: string;
  readonly sellerOrderId: string;
}

/**
 * `ordering.delivered-seller-order-facts`: the facts of one delivered seller order, for
 * promotions' credits on delivery (customers phase 4c: cashback). Rule `system`. The goods are the
 * seller order's lines as charged, without tax (a tax-inclusive line's frozen tax is taken out)
 * and without shipping. A seller order not delivered (or of an order not confirmed), or with a line placed before its tax was
 * recorded, is `ordering.facts-unavailable`: no amount is guessed.
 */
export class DeliveredSellerOrderFactsQuery extends UseCase<
  DeliveredSellerOrderFactsInput,
  DeliveredSellerOrderFacts,
  DeliveredSellerOrderFactsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.delivered-seller-order-facts',
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
    input: DeliveredSellerOrderFactsInput,
  ): Promise<Result<DeliveredSellerOrderFacts, DeliveredSellerOrderFactsFailure>> {
    const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
    const sellerOrderId =
      typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
    if (orderId === null || !orderId.ok || sellerOrderId === null || !sellerOrderId.ok) {
      return err({ code: 'validation.failed' });
    }
    return this.deps.unitOfWork.run<DeliveredSellerOrderFacts, DeliveredSellerOrderFactsFailure>(
      context.market,
      async () => {
        const order = await this.deps.orders.findById(context.market, orderId.value);
        const sellerOrder = order?.sellerOrders.find((s) => s.id === sellerOrderId.value);
        if (order === null || order === undefined || sellerOrder === undefined) {
          return err({ code: 'ordering.order-not-found' } as const);
        }
        if (
          order.status !== 'confirmed' ||
          sellerOrder.fulfilment !== 'delivered' ||
          sellerOrder.deliveredAt === null
        ) {
          return err({ code: 'ordering.facts-unavailable' } as const);
        }
        let goods = 0n;
        for (const line of order.lines) {
          if (line.sellerOrderId !== sellerOrder.id) continue;
          if (line.taxInclusive && line.taxAmount === null) {
            return err({ code: 'ordering.facts-unavailable' } as const);
          }
          goods += line.lineAmount - (line.taxInclusive ? line.taxAmount! : 0n);
        }
        return ok({
          orderId: order.id,
          sellerOrderId: sellerOrder.id,
          sellerId: sellerOrder.sellerId,
          customerAccountId: order.accountId,
          currency: order.total.currency,
          goods,
          placedAt: order.createdAt,
          deliveredAt: sellerOrder.deliveredAt,
        });
      },
      { readOnly: true },
    );
  }
}
