import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { listAllOrders } from '../read-flow';
import { ADMIN_ORDERS_HEADER, adminOrderRow } from '../orders-csv';
import { ordersExport, type OrdersExportFailure, type OrdersExportOutput } from '../orders-export';

const FILTER_KEYS = new Set([
  'status',
  'q',
  'paymentState',
  'fulfilment',
  'sellerId',
  'from',
  'to',
]);

/**
 * The Market's orders as a CSV file (admin Orders page, Export): the orders the list shows for the
 * same filter (`status`, `q`, `paymentState`, `fulfilment`, `sellerId`, `from`, `to`), newest
 * first, at most 10,000 (more is `batch.too-large`). One row per order with its totals, payment
 * state and stores; no customer name or email. Rule: `permissions [ordering.order.view]`, the
 * same as the list it reads through.
 */
export class AdminExportOrders extends UseCase<unknown, OrdersExportOutput, OrdersExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-export-orders',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return ordersExport(this.deps.clock, input, {
      allowed: FILTER_KEYS,
      header: ADMIN_ORDERS_HEADER,
      name: 'orders',
      read: async (extra) => {
        const result = await listAllOrders(this.deps, context, extra);
        return result.ok
          ? {
              ok: true,
              value: {
                rows: result.value.orders.map(adminOrderRow),
                nextCursor: result.value.nextCursor,
                total: result.value.paging?.total ?? null,
              },
            }
          : result;
      },
    });
  }
}
