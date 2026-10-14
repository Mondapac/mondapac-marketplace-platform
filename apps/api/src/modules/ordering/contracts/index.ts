// Public contracts of the ordering module (ADR-0008): the permission catalogue and the facade
// interface. Other modules may import only what this file exports, through ../index.ts.
export { ORDERING_ORDER_VIEW, ORDERING_PERMISSIONS } from './permissions';
export {
  ORDERING_FACADE,
  type AuthorisedPayment,
  type OrderingFacade,
  type PaymentFailure,
} from './ordering.facade';
