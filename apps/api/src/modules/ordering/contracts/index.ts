// Public contracts of the ordering module (ADR-0008): the permission catalogue and the facade
// interface. Other modules may import only what this file exports, through ../index.ts.
export {
  ORDERING_ORDER_REFUND,
  ORDERING_ORDER_VIEW,
  ORDERING_PERMISSIONS,
  ORDERING_REFUND_LIMITS_MANAGE,
  ORDERING_REFUND_LIMITS_VIEW,
  ORDERING_SAVED_FILTER_SHARE,
  ORDERING_SELLER_ORDER_CONFIRM_PICKUP,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_MARK_READY,
  ORDERING_SELLER_ORDER_MARK_UNAVAILABLE,
  ORDERING_SELLER_ORDER_VIEW,
} from './permissions';
export {
  ORDERING_EVENTS,
  OrderPaid,
  OrderShipped,
  RefundSucceeded,
  SellerOrderDelivered,
  SellerRefundLimitReached,
} from '../domain/events';
export { SELLER_UNAVAILABLE_REASON, type RefundReason } from '../domain/refund';
export {
  MAX_DELIVERED_SELLER_ORDERS,
  ORDERING_FACADE,
  type DeliveredSellerOrder,
  type DeliveredSellerOrdersFailure,
  type SellerOrderHealthCount,
  type SellerOrderHealthCountsFailure,
  type OrderNotice,
  type OrderNoticeFailure,
  type OwnOpenObligations,
  type OwnOpenObligationsFailure,
  type OrderPaymentRef,
  type OrderPaymentRefFailure,
  type SellerOrderCustomerName,
  type SellerOrderCustomerNamesFailure,
  type RefundNotice,
  type RefundNoticeFailure,
  type ShipmentNotice,
  type ShipmentNoticeFailure,
  type AuthorisedPayment,
  type OrderingFacade,
  type PaymentFailure,
} from './ordering.facade';
export {
  BESTSELLER_WINDOW_DAYS,
  BOUGHT_TOGETHER_MIN_BUYERS,
  BOUGHT_TOGETHER_WINDOW_DAYS,
  MAX_BOUGHT_TOGETHER,
  MAX_RANKED_OFFERS,
  ORDERING_RANKING_FACADE,
  type OrderingRankingFacade,
  type RankingFailure,
} from './ordering-ranking.facade';
