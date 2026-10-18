import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { NOTICES_PER_SELLER, SELLER_ORDER_PAID } from '../../domain/in-app-notice';
import type { InAppNoticeDependencies } from '../in-app-notice-flow';

export interface RecordSellerOrderNoticesInput {
  readonly delivery: EventDelivery;
  readonly orderId: string;
}

export type RecordSellerOrderNoticesOutput =
  | { readonly code: 'notices.recorded'; readonly notices: number }
  | { readonly code: 'notices.skipped'; readonly reason: 'order.gone' }
  | { readonly code: 'notices.already-handled' };

export type RecordSellerOrderNoticesFailure = { readonly code: 'access.denied' };

/**
 * The sellers' "New order" in-app notice (in-app notifications package 1), from the subscription
 * `notifications.seller-order-notice` on `ordering.order-paid.v1`: one notice per seller order of
 * the paid order, holding the seller order id, its number of items and the customer's account id
 * (an id only; no name, address or email). Written in the inbox unit, so a repeated delivery adds nothing; the seller's oldest
 * notices beyond the cap leave in the same unit. Rule `system`.
 */
export class RecordSellerOrderNotices extends UseCase<
  RecordSellerOrderNoticesInput,
  RecordSellerOrderNoticesOutput,
  RecordSellerOrderNoticesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.record-seller-order-notices',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecordSellerOrderNotices');

  constructor(
    gate: UseCaseGate,
    private readonly deps: InAppNoticeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecordSellerOrderNoticesInput,
  ): Promise<Result<RecordSellerOrderNoticesOutput, RecordSellerOrderNoticesFailure>> {
    // Read before the unit (P 3.1 row 5): the order is ordering's, through its facade.
    const notice = await this.deps.ordering.orderNotice(context, input.orderId);
    let output: RecordSellerOrderNoticesOutput;
    if (!notice.ok) {
      if (notice.error.code === 'access.denied') return err({ code: 'access.denied' });
      if (notice.error.code !== 'ordering.order-not-found') {
        throw new Error(`seller-order-notice: the order could not be read: ${notice.error.code}`);
      }
      const marked = await this.deps.unitOfWork.runOnce(context.market, input.delivery, () =>
        Promise.resolve(ok(undefined)),
      );
      if (!marked.ok) throw new Error('seller-order-notice: the inbox unit failed');
      output = marked.value.handled
        ? { code: 'notices.skipped', reason: 'order.gone' }
        : { code: 'notices.already-handled' };
    } else {
      const now = this.deps.clock.now();
      const notices = notice.value.sellerOrders.map((sellerOrder) => ({
        id: this.deps.ids.next<'InAppNotice'>(),
        sellerId: sellerOrder.sellerId,
        kind: SELLER_ORDER_PAID,
        params: {
          sellerOrderId: sellerOrder.sellerOrderId,
          // No customer data: the panel's short name ("Maryam R.", john 2026-10-17) is read at
          // display time from the seller order, under the permission that shows customers.
          items: sellerOrder.lines.reduce((sum, line) => sum + line.quantity, 0),
        },
        createdAt: now,
      }));
      const written = await this.deps.unitOfWork.runOnce(
        context.market,
        input.delivery,
        async () => {
          await this.deps.notices.addForSellers(context.market, notices);
          for (const sellerId of new Set(notices.map((item) => item.sellerId))) {
            await this.deps.notices.trimSeller(context.market, sellerId, NOTICES_PER_SELLER);
          }
          return ok(notices.length);
        },
      );
      if (!written.ok) throw new Error('seller-order-notice: the inbox unit failed');
      output = written.value.handled
        ? { code: 'notices.recorded', notices: written.value.value }
        : { code: 'notices.already-handled' };
    }
    // Ids and codes only.
    this.#logger.log({
      msg: `notifications.${output.code}`,
      ...('notices' in output ? { notices: output.notices } : {}),
      ...('reason' in output ? { reason: output.reason } : {}),
      orderId: input.orderId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
