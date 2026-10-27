import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  MAX_DELIVERED_SELLER_ORDERS,
  type DeliveredSellerOrder,
  type DeliveredSellerOrdersFailure,
} from '../../contracts/ordering.facade';
import type { OrderingDependencies } from '../checkout-flow';
import { customerAccountId } from '../customer-caller';

interface Input {
  readonly deliveredSince: Temporal.Instant;
  readonly sellerOrderId?: string;
}

/**
 * `ordering.my-delivered-seller-orders`: the signed-in customer's own delivered seller orders,
 * for `reviews` (verified buyers only: owner decision N1 of the reviews package). Rule
 * `own-resources`, denied for an unapproved seller; the customer is the session's, so another
 * customer's orders cannot be asked for, and an unknown or foreign `sellerOrderId` is an empty
 * list, byte-identical. Ids and the delivery instant only. One read-only unit.
 */
export class MyDeliveredSellerOrders extends UseCase<
  Input,
  readonly DeliveredSellerOrder[],
  DeliveredSellerOrdersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.my-delivered-seller-orders',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly DeliveredSellerOrder[], DeliveredSellerOrdersFailure>> {
    const accountId = customerAccountId(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const since: unknown = input?.deliveredSince;
    if (!(since instanceof Temporal.Instant)) return err({ code: 'validation.failed' });
    let sellerOrderId: Id<'SellerOrder'> | null = null;
    if (input.sellerOrderId !== undefined) {
      const parsed =
        typeof input.sellerOrderId === 'string'
          ? parseId<'SellerOrder'>(input.sellerOrderId)
          : null;
      if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
      sellerOrderId = parsed.value;
    }
    return this.deps.unitOfWork.run<readonly DeliveredSellerOrder[], DeliveredSellerOrdersFailure>(
      context.market,
      async () =>
        ok(
          await this.deps.orders.deliveredSellerOrdersOf(context.market, accountId, {
            deliveredSince: since,
            sellerOrderId,
            limit: MAX_DELIVERED_SELLER_ORDERS,
          }),
        ),
      { readOnly: true },
    );
  }
}
