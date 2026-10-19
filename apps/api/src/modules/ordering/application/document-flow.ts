import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  orderDocument,
  sellerOrderDocument,
  type OrderDocumentView,
} from '../domain/order-document';
import type { OrderingDependencies } from './checkout-flow';
import { viewSellerOrder, type FulfilmentFailure } from './fulfilment-flow';
import type { OrderState } from '../domain/order';
import { orderView } from '../domain/order-views';
import { parseOrderId, viewAnyOrder, type ReadFailure } from './read-flow';

// The order document of a paid order (tax step 4), for the customer (own orders), the seller (own
// seller orders) and an admin, each through the same read as its order page, so ownership is the
// page's. It holds ids, codes, money and instants only: no address, name or email. Switched on, `tax.invoice.enabled` asks for a numbered tax invoice that cannot be issued
// yet (no gap-free numbering, AG-11): the document fails closed instead of carrying no number.

export type DocumentFailure =
  | ReadFailure
  | FulfilmentFailure
  /** The order is not paid: there is nothing to document yet. */
  | { readonly code: 'ordering.document-not-available' }
  /** `tax.invoice.enabled` is on, but invoice numbering is not built (AG-11). */
  | { readonly code: 'ordering.invoice-numbering-unavailable' };

const NUMBERING: DocumentFailure = { code: 'ordering.invoice-numbering-unavailable' };

/** The customer's own paid order (the same read as the order page, without the address). */
export async function ownOrderDocument(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly orderId: unknown },
): Promise<Result<OrderDocumentView, DocumentFailure>> {
  if (deps.policy.invoicesEnabled(context.market)) return err(NUMBERING);
  const orderId = parseOrderId(input?.orderId);
  if (!orderId.ok) return orderId;
  const read = await deps.unitOfWork.run<OrderState, ReadFailure>(
    context.market,
    async () => {
      const order = await deps.orders.findOwn(context.market, orderId.value, accountId);
      return order === null ? err({ code: 'ordering.order-not-found' } as const) : ok(order);
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const document = orderDocument(orderView(read.value));
  return document === null ? err({ code: 'ordering.document-not-available' }) : ok(document);
}

/** Any paid order of the Market, for an admin. */
export async function anyOrderDocument(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly orderId: unknown },
): Promise<Result<OrderDocumentView, DocumentFailure>> {
  if (deps.policy.invoicesEnabled(context.market)) return err(NUMBERING);
  const read = await viewAnyOrder(deps, context, input);
  if (!read.ok) return read;
  const document = orderDocument(read.value);
  return document === null ? err({ code: 'ordering.document-not-available' }) : ok(document);
}

/** The seller's own part of a paid order. */
export async function ownSellerOrderDocument(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<OrderDocumentView, DocumentFailure>> {
  if (deps.policy.invoicesEnabled(context.market)) return err(NUMBERING);
  const read = await viewSellerOrder(deps, context, input);
  return read.ok ? ok(sellerOrderDocument(read.value)) : read;
}
