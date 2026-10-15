import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderNotice, OrderNoticeFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * `order-notice`: the paid order behind `ordering.order-paid.v1`, for the order emails. Rule
 * `system`; `notifications` calls it through the ordering facade. It answers ids and quantities
 * only (no name, address, email or amount) and only for a confirmed order.
 */
export class OrderNoticeQuery extends UseCase<
  { readonly orderId: string },
  OrderNotice,
  OrderNoticeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.order-notice',
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
    input: { readonly orderId: string },
  ): Promise<Result<OrderNotice, OrderNoticeFailure>> {
    const parsed = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
    return this.deps.unitOfWork.run<OrderNotice, OrderNoticeFailure>(
      context.market,
      async () => {
        const order = await this.deps.orders.findById(context.market, parsed.value);
        if (order === null || order.status !== 'confirmed') {
          return err({ code: 'ordering.order-not-found' } as const);
        }
        return ok({
          orderId: order.id,
          accountId: order.accountId,
          sellerOrders: order.sellerOrders.map((sellerOrder) => ({
            sellerOrderId: sellerOrder.id,
            sellerId: sellerOrder.sellerId,
            lines: order.lines
              .filter((line) => line.sellerOrderId === sellerOrder.id)
              .map((line) => ({ offerId: line.offerId, quantity: line.quantity })),
          })),
        });
      },
      { readOnly: true },
    );
  }
}
