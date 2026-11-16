import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import {
  MAX_SELLER_CUSTOMER_ORDERS,
  type SellerCustomerOrders,
  type SellerCustomerOrdersFailure,
} from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

interface Input {
  readonly accountId: Id<'Account'>;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * `seller-customer-orders` (customers management phase 3): one page of the calling seller's own
 * paid seller orders of one customer, newest payment first, for the seller's customer page. Rule
 * `permissions [ordering.seller-order.view]`; the seller is the session's, never an input. The
 * customer's account id is given by `customers`, which resolved the seller's own customer code;
 * it is never answered back. Ids, amounts, fulfilment and times only.
 */
export class SellerCustomerOrdersQuery extends UseCase<
  Input,
  SellerCustomerOrders,
  SellerCustomerOrdersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-customer-orders',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
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
  ): Promise<Result<SellerCustomerOrders, SellerCustomerOrdersFailure>> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'seller') {
      return err({ code: 'access.denied' });
    }
    // A Login as Seller session reads no customer's orders (defence in depth: customers refuses
    // it too). The account id must come from customers' own lookup of the seller's code.
    if (Object.hasOwn(actor, 'actingAs') && (actor as { actingAs?: unknown }).actingAs != null) {
      return err({ code: 'access.denied' });
    }
    const seller = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
    if (seller === null || !seller.ok) return err({ code: 'access.denied' });
    const account =
      typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    const whole = (value: unknown, max: number) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
    if (
      account === null ||
      !account.ok ||
      !whole(input.page, 1000) ||
      !whole(input.pageSize, MAX_SELLER_CUSTOMER_ORDERS)
    ) {
      return err({ code: 'validation.failed' });
    }
    const sellerId = seller.value;
    const filter = { fulfilment: null, from: null, to: null, accountId: account.value };
    return this.deps.unitOfWork.run<SellerCustomerOrders, SellerCustomerOrdersFailure>(
      context.market,
      async () => {
        const [rows, total] = await Promise.all([
          this.deps.orders.pageForSeller(
            context.market,
            sellerId,
            filter,
            { key: 'paid', direction: 'desc' },
            (input.page - 1) * input.pageSize,
            input.pageSize,
          ),
          this.deps.orders.countMatchingForSeller(context.market, sellerId, filter),
        ]);
        return ok({
          total,
          items: rows.map((row) => ({
            sellerOrderId: row.sellerOrder.id,
            orderId: row.orderId,
            paidAt: row.confirmedAt,
            total: { amount: row.sellerOrder.total, currency: row.currency },
            fulfilment: row.sellerOrder.fulfilment,
            deliveredAt: row.sellerOrder.deliveredAt,
          })),
        });
      },
      { readOnly: true },
    );
  }
}
