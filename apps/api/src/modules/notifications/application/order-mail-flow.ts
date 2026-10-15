import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { MailTransport } from '../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CatalogFacade } from '../../catalog';
import type { IdentityFacade } from '../../identity';
import type { OrderingFacade, OrderNotice } from '../../ordering';
import { orderConfirmationMail, sellerNewOrderMail, type MailLine } from '../domain/order-mail';
import type { NotificationsPolicy } from './ports/notifications-policy';

export interface OrderMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ordering: OrderingFacade;
  readonly catalog: CatalogFacade;
  readonly identity: IdentityFacade;
  readonly transport: MailTransport;
  readonly policy: NotificationsPolicy;
}

/** One delivery of `ordering.order-paid.v1`: the order id only; everything else is read now. */
export interface OrderMailInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
}

export type OrderMailSkipped = 'order.gone' | 'recipient.none' | 'link.unconfigured';

export type OrderMailOutput =
  | { readonly code: 'order-mail.sent'; readonly sent: number }
  | { readonly code: 'order-mail.skipped'; readonly reason: OrderMailSkipped }
  | { readonly code: 'order-mail.already-handled' };

export type OrderMailFailure = { readonly code: 'access.denied' };

const logger = new Logger('OrderMail');

/** Reads the paid order. `null` when it is gone; throws on a fault so the delivery is retried. */
async function readOrder(
  deps: OrderMailDependencies,
  context: CallContext,
  orderId: string,
): Promise<Result<OrderNotice | null, OrderMailFailure>> {
  const notice = await deps.ordering.orderNotice(context, orderId);
  if (notice.ok) return ok(notice.value);
  if (notice.error.code === 'access.denied') return err({ code: 'access.denied' });
  if (notice.error.code === 'ordering.order-not-found') return ok(null);
  throw new Error(`order-mail: the order could not be read: ${notice.error.code}`);
}

/** The product names of the Offers, by id; a name that is missing is simply absent. */
async function readNames(
  deps: OrderMailDependencies,
  context: CallContext,
  offerIds: readonly Id<'Offer'>[],
): Promise<ReadonlyMap<Id<'Offer'>, string>> {
  const names = await deps.catalog.offerNames(
    context,
    [...new Set(offerIds)],
    deps.policy.defaultLocale(context.market),
  );
  // Names are a nicety: a refusal degrades to the fallback name, never to a lost email.
  return names.ok ? names.value : new Map();
}

async function recipientOf(
  deps: OrderMailDependencies,
  context: CallContext,
  target: Parameters<IdentityFacade['contactEmailOf']>[1],
): Promise<string | null> {
  const found = await deps.identity.contactEmailOf(context, target);
  if (!found.ok) throw new Error('order-mail: the address could not be read');
  return found.value;
}

async function finish(
  deps: OrderMailDependencies,
  context: CallContext,
  input: OrderMailInput,
  name: string,
  outcome: { readonly sent: number } | { readonly skipped: OrderMailSkipped },
): Promise<Result<OrderMailOutput, OrderMailFailure>> {
  const marked = await deps.unitOfWork.runOnce(context.market, input.delivery, () =>
    Promise.resolve(ok(undefined)),
  );
  if (!marked.ok) throw new Error(`${name}: the inbox unit failed`);
  const output: OrderMailOutput = !marked.value.handled
    ? { code: 'order-mail.already-handled' }
    : 'skipped' in outcome
      ? { code: 'order-mail.skipped', reason: outcome.skipped }
      : { code: 'order-mail.sent', sent: outcome.sent };
  // Ids and codes only: never an address, a name or a body.
  logger.log({
    msg: `notifications.${output.code}`,
    handler: name,
    ...('reason' in output ? { reason: output.reason } : {}),
    ...('sent' in output ? { sent: output.sent } : {}),
    orderId: input.orderId,
    eventId: input.delivery.eventId,
    attempt: input.delivery.attempt,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  return ok(output);
}

/** The customer's "Order confirmation", once the order is paid. */
export async function sendOrderConfirmation(
  deps: OrderMailDependencies,
  context: CallContext,
  input: OrderMailInput,
): Promise<Result<OrderMailOutput, OrderMailFailure>> {
  const name = 'notifications.order-confirmation-mail';
  const order = await readOrder(deps, context, input.orderId);
  if (!order.ok) return order;
  if (order.value === null) return finish(deps, context, input, name, { skipped: 'order.gone' });
  const url = deps.policy.customerOrderUrl(context.market, order.value.orderId);
  if (url === null) return finish(deps, context, input, name, { skipped: 'link.unconfigured' });
  const to = await recipientOf(deps, context, {
    kind: 'customer',
    accountId: order.value.accountId,
  });
  if (to === null) return finish(deps, context, input, name, { skipped: 'recipient.none' });

  const sellerOrders = order.value.sellerOrders;
  const names = await readNames(
    deps,
    context,
    sellerOrders.flatMap((sellerOrder) => sellerOrder.lines.map((line) => line.offerId)),
  );
  const lines: MailLine[] = sellerOrders.flatMap((sellerOrder) =>
    sellerOrder.lines.map((line) => ({
      name: names.get(line.offerId) ?? null,
      quantity: line.quantity,
    })),
  );
  const composed = orderConfirmationMail({
    orderId: order.value.orderId,
    lines,
    orderUrl: url,
  });
  // A send failure throws: the delivery is retried by the outbox, the order is already paid.
  await deps.transport.send({
    to,
    from: deps.policy.mailSender(context.market),
    subject: composed.subject,
    text: composed.text,
  });
  return finish(deps, context, input, name, { sent: 1 });
}

/** The "New order" mail to each seller of the order, one per seller order. */
export async function sendSellerNewOrders(
  deps: OrderMailDependencies,
  context: CallContext,
  input: OrderMailInput,
): Promise<Result<OrderMailOutput, OrderMailFailure>> {
  const name = 'notifications.seller-new-order-mail';
  const order = await readOrder(deps, context, input.orderId);
  if (!order.ok) return order;
  if (order.value === null) return finish(deps, context, input, name, { skipped: 'order.gone' });

  const names = await readNames(
    deps,
    context,
    order.value.sellerOrders.flatMap((sellerOrder) =>
      sellerOrder.lines.map((line) => line.offerId),
    ),
  );
  let sent = 0;
  let failed = false;
  for (const sellerOrder of order.value.sellerOrders) {
    // One seller's fault must not stop the others; the delivery is retried afterwards.
    try {
      const to = await recipientOf(deps, context, {
        kind: 'seller-owner',
        sellerId: sellerOrder.sellerId,
      });
      if (to === null) continue;
      const composed = sellerNewOrderMail({
        sellerOrderId: sellerOrder.sellerOrderId,
        lines: sellerOrder.lines.map((line) => ({
          name: names.get(line.offerId) ?? null,
          quantity: line.quantity,
        })),
      });
      await deps.transport.send({
        to,
        from: deps.policy.mailSender(context.market),
        subject: composed.subject,
        text: composed.text,
      });
      sent += 1;
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('notifications.seller-new-order-mail: a send failed');
  return finish(deps, context, input, name, sent === 0 ? { skipped: 'recipient.none' } : { sent });
}
