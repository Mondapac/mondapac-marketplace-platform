// Public contracts of the payments module (ADR-0008): the facade interface and its token.
// Other modules may import only what this file exports, through ../index.ts.
export { PAYMENTS_FACADE } from './payments.facade';
export type { Dispute, DisputeStatus, PayoutReadiness, PaymentsFacade } from './payments.facade';
export {
  PAYMENTS_CONNECTED_ACCOUNT_VIEW,
  PAYMENTS_PAYOUT_ACCOUNT_MANAGE,
  PAYMENTS_PAYOUT_ACCOUNT_VIEW,
  PAYMENTS_PERMISSIONS,
} from './permissions';
