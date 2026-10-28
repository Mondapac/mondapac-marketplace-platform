import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { CancelPayment } from '../application/use-cases/cancel-payment.use-case';
import type { MyDeliveredSellerOrders } from '../application/use-cases/my-delivered-seller-orders.use-case';
import type { OrderPaymentRefQuery } from '../application/use-cases/order-payment-ref.use-case';
import type { OrderNoticeQuery } from '../application/use-cases/order-notice.use-case';
import type { OpenObligationsOfQuery } from '../application/use-cases/open-obligations-of.use-case';
import type { OwnOpenObligationsQuery } from '../application/use-cases/own-open-obligations.use-case';
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
    private readonly openObligations: OwnOpenObligationsQuery,
    private readonly openObligationsOfAccount: OpenObligationsOfQuery,
    private readonly delivered: MyDeliveredSellerOrders,
    private readonly paymentRef: OrderPaymentRefQuery,
  ) {}

  orderPaymentRef(context: CallContext, orderId: string) {
    return this.paymentRef.execute(context, { orderId });
  }

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

  ownOpenObligations(context: CallContext) {
    return this.openObligations.execute(context, {});
  }

  openObligationsOf(context: CallContext, accountId: Id<'Account'>) {
    return this.openObligationsOfAccount.execute(context, { accountId });
  }

  myDeliveredSellerOrders(
    context: CallContext,
    request: { readonly deliveredSince: Temporal.Instant; readonly sellerOrderId?: string },
  ) {
    return this.delivered.execute(context, request);
  }
}
