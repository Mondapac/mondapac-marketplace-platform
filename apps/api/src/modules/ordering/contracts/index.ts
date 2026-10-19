// Public contracts of the ordering module (ADR-0008): the permission catalogue and the facade
// interface. Other modules may import only what this file exports, through ../index.ts.
export {
  ORDERING_ORDER_REFUND,
  ORDERING_ORDER_VIEW,
  ORDERING_PERMISSIONS,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_SHIP,
  ORDERING_SELLER_ORDER_VIEW,
} from './permissions';
export { ORDERING_EVENTS, OrderPaid, OrderShipped } from '../domain/events';
export {
  ORDERING_FACADE,
  type OrderNotice,
  type OrderNoticeFailure,
  type SellerOrderCustomerName,
  type SellerOrderCustomerNamesFailure,
  type ShipmentNotice,
  type ShipmentNoticeFailure,
  type AuthorisedPayment,
  type OrderingFacade,
  type PaymentFailure,
} from './ordering.facade';
export {
  BESTSELLER_WINDOW_DAYS,
  MAX_RANKED_OFFERS,
  ORDERING_RANKING_FACADE,
  type OrderingRankingFacade,
  type RankingFailure,
} from './ordering-ranking.facade';
