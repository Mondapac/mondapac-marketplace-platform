// Public contracts of the wallet module (ADR-0008): the facade interface, the permission keys and
// the audit actions. Other modules may import only what this file exports, through ../index.ts.
export { WALLET_AUDIT_ACTIONS } from '../domain/audit';
export {
  WALLET_STATUS_REASONS,
  WALLET_STATUSES,
  type WalletStatus,
  type WalletStatusReason,
} from '../domain/wallet-status';
export { WALLET_PERMISSIONS, WALLET_SETTINGS_MANAGE, WALLET_SETTINGS_VIEW } from './permissions';
export {
  WALLET_FACADE,
  type GrantCreditRequest,
  type GrantCreditResult,
  type HoldResult,
  type PlaceHoldRequest,
  type SettleHoldRequest,
  type WalletBalance,
  type WalletBalanceView,
  type WalletFacade,
  type WalletFailure,
} from './wallet.facade';
