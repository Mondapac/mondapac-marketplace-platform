import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  orderActivity,
  sellerOrderActivity,
  type OrderActivityEvent,
} from '../domain/order-activity';
import type { OrderingDependencies } from './checkout-flow';

// The order activity timeline (order detail, panels row 4): read-only, built by the domain from
// the order, its seller orders and its refunds, all read in one read-only unit of ordering's own
// tables (no other module is asked). The admin sees the whole order; the seller one seller order
// of its own shop, found by the session's seller only (another shop's id answers as unknown).

export type ActivityFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'ordering.order-not-found' }
  | { readonly code: 'ordering.seller-order-not-found' };

export interface OrderActivityView {
  /** Oldest first. */
  readonly events: readonly OrderActivityEvent[];
}

const idOf = <T extends string>(value: unknown): Id<T> | null => {
  const parsed = typeof value === 'string' ? parseId<T>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/** The whole order's timeline for an admin. */
export async function adminOrderActivity(
  deps: Pick<OrderingDependencies, 'unitOfWork' | 'orders' | 'refunds'>,
  context: CallContext,
  input: { readonly orderId: unknown },
): Promise<Result<OrderActivityView, ActivityFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const orderId = idOf<'Order'>(input?.orderId);
  if (orderId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'orderId', code: 'format' }] });
  }
  return deps.unitOfWork.run<OrderActivityView, ActivityFailure>(
    context.market,
    async () => {
      const order = await deps.orders.findById(context.market, orderId);
      if (order === null) return err({ code: 'ordering.order-not-found' } as const);
      const refunds = await deps.refunds.listForOrder(context.market, orderId);
      return ok({
        events: orderActivity(
          order,
          refunds.map(({ refund }) => refund),
        ),
      });
    },
    { readOnly: true },
  );
}

/** One of the seller's own paid seller orders' timeline. */
export async function sellerActivity(
  deps: Pick<OrderingDependencies, 'unitOfWork' | 'orders' | 'refunds'>,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<OrderActivityView, ActivityFailure>> {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') {
    return err({ code: 'access.denied' });
  }
  const sellerId = idOf<'Seller'>(actor.sellerId);
  if (sellerId === null) return err({ code: 'access.denied' });
  const sellerOrderId = idOf<'SellerOrder'>(input?.sellerOrderId);
  if (sellerOrderId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] });
  }
  return deps.unitOfWork.run<OrderActivityView, ActivityFailure>(
    context.market,
    async () => {
      const record = await deps.orders.findForSeller(context.market, sellerId, sellerOrderId);
      if (record === null) return err({ code: 'ordering.seller-order-not-found' } as const);
      const refunds = await deps.refunds.listOfSellerOrder(context.market, sellerOrderId, sellerId);
      return ok({ events: sellerOrderActivity(record, refunds) });
    },
    { readOnly: true },
  );
}
