import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderPaymentRef, OrderPaymentRefFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

interface OrderPaymentRefInput {
  readonly orderId: string;
}

/**
 * `order-payment-ref`: the PaymentIntent the order itself holds, for the dispute consumer of
 * `commission-payouts` (package 8b), which checks a dispute's PaymentIntent against it. Rule
 * `system`. Ids only: no amount, name or address. An unknown or foreign-Market order is
 * `ordering.order-not-found`; an order that never had a PaymentIntent answers `null`.
 */
export class OrderPaymentRefQuery extends UseCase<
  OrderPaymentRefInput,
  OrderPaymentRef,
  OrderPaymentRefFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.order-payment-ref',
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
    input: OrderPaymentRefInput,
  ): Promise<Result<OrderPaymentRef, OrderPaymentRefFailure>> {
    const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
    if (orderId === null || !orderId.ok) return err({ code: 'validation.failed' });
    return this.deps.unitOfWork.run<OrderPaymentRef, OrderPaymentRefFailure>(
      context.market,
      async () => {
        const order = await this.deps.orders.findById(context.market, orderId.value);
        if (order === null) return err({ code: 'ordering.order-not-found' } as const);
        return ok({ orderId: order.id, paymentIntentId: order.stripePaymentIntentId });
      },
      { readOnly: true },
    );
  }
}
