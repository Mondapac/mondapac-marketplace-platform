import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { listSellerOrders } from '../fulfilment-flow';
import { SELLER_ORDERS_HEADER, sellerOrderRow } from '../orders-csv';
import { ordersExport, type OrdersExportFailure, type OrdersExportOutput } from '../orders-export';

const FILTER_KEYS = new Set(['status', 'from', 'to']);

/**
 * The seller's paid orders as a CSV file (seller Orders page, Export): the seller orders the list
 * shows for the same filter (`status` = fulfilment step, `from`, `to`), newest payment first, at
 * most 10,000 (more is `batch.too-large`). One row per seller order with its amounts, delivery
 * method and tracking; no buyer name, email, phone or address. Rule:
 * `permissions [ordering.seller-order.view]` and an approved seller, the same as the list.
 */
export class SellerExportOrders extends UseCase<unknown, OrdersExportOutput, OrdersExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-export-orders',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return ordersExport(this.deps.clock, input, {
      allowed: FILTER_KEYS,
      header: SELLER_ORDERS_HEADER,
      name: 'seller-orders',
      read: async (extra) => {
        const result = await listSellerOrders(this.deps, context, extra);
        return result.ok
          ? {
              ok: true,
              value: {
                rows: result.value.sellerOrders.map(sellerOrderRow),
                nextCursor: result.value.nextCursor,
                total: result.value.paging?.total ?? null,
              },
            }
          : result;
      },
    });
  }
}
