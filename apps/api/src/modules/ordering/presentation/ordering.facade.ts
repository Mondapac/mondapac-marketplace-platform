import type { CallContext } from '@mondapac/shared-kernel';
import type { CancelPayment } from '../application/use-cases/cancel-payment.use-case';
import type { OrderNoticeQuery } from '../application/use-cases/order-notice.use-case';
import type { SellerOrderCustomerNames } from '../application/use-cases/seller-order-customer-names.use-case';
import type { ShipmentNoticeQuery } from '../application/use-cases/shipment-notice.use-case';
import type { ConfirmPayment } from '../application/use-cases/confirm-payment.use-case';
import type { AuthorisedPayment, OrderingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class OrderingFacadeImplementation implements OrderingFacade {
  constructor(
    private readonly confirm: ConfirmPayment,
    private readonly cancel: CancelPayment,
    private readonly notice: OrderNoticeQuery,
    private readonly shipment: ShipmentNoticeQuery,
    private readonly customerNames: SellerOrderCustomerNames,
  ) {}

  confirmPayment(context: CallContext, payment: AuthorisedPayment) {
    return this.confirm.execute(context, payment);
  }

  cancelPayment(
    context: CallContext,
    request: { readonly orderId: string; readonly cause: 'expired' | 'payment-failed' },
  ) {
    return this.cancel.execute(context, request);
  }

  orderNotice(context: CallContext, orderId: string) {
    return this.notice.execute(context, { orderId });
  }

  shipmentNotice(
    context: CallContext,
    request: { readonly orderId: string; readonly sellerOrderId: string },
  ) {
    return this.shipment.execute(context, request);
  }

  sellerOrderCustomerNames(context: CallContext, sellerOrderIds: readonly string[]) {
    return this.customerNames.execute(context, { sellerOrderIds });
  }
}
