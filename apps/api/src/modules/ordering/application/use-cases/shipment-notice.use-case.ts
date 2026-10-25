import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ShipmentNotice, ShipmentNoticeFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

interface ShipmentNoticeInput {
  readonly orderId: string;
  readonly sellerOrderId: string;
}

/**
 * `shipment-notice`: the shipped seller order behind `ordering.order-shipped.v1`, for the
 * "Shipped" email. Rule `system`; `notifications` calls it through the ordering facade. It
 * answers the carrier, the tracking number the seller typed in or the fleet's tracking page, and ids; no name, address,
 * email or amount. Only a confirmed order whose seller order is shipped (or delivered) answers.
 */
export class ShipmentNoticeQuery extends UseCase<
  ShipmentNoticeInput,
  ShipmentNotice,
  ShipmentNoticeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.shipment-notice',
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
    input: ShipmentNoticeInput,
  ): Promise<Result<ShipmentNotice, ShipmentNoticeFailure>> {
    const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
    if (orderId === null || !orderId.ok) return err({ code: 'validation.failed' });
    const read = await this.deps.unitOfWork.run<ShipmentNotice, ShipmentNoticeFailure>(
      context.market,
      async () => {
        const order = await this.deps.orders.findById(context.market, orderId.value);
        const sellerOrder = order?.sellerOrders.find((s) => s.id === input.sellerOrderId);
        if (
          order === null ||
          order.status !== 'confirmed' ||
          sellerOrder === undefined ||
          sellerOrder.fulfilment === 'to-ship' ||
          sellerOrder.carrier === null
        ) {
          return err({ code: 'ordering.order-not-found' } as const);
        }
        return ok({
          orderId: order.id,
          accountId: order.accountId,
          sellerOrderId: sellerOrder.id,
          carrier: sellerOrder.carrier,
          trackingRef: sellerOrder.trackingRef,
          trackingUrl: null,
        });
      },
      { readOnly: true },
    );
    if (!read.ok) return read;
    // The fleet's tracking page, read after the unit (shipping opens its own). A fleet that gave
    // none, a seller who shipped alone, or a failed read is no link: the mail still goes.
    const shipment = await this.deps.shipping.carrierShipment(context, input.sellerOrderId);
    const url = shipment.ok ? shipment.value.trackingUrl : null;
    return ok({
      ...read.value,
      trackingUrl: url !== null && url.startsWith('https://') ? url : null,
    });
  }
}
