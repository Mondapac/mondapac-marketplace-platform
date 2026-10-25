// The runtime switch of the wallet in one Market (customer wallet package 1; owner decisions of
// 2026-10-25). It never deletes or zeroes a balance or a lot: it only decides which operations
// may start. A hold that exists is always settled: release and expiry are allowed in every state
// except `off` (where nothing exists), capture in `active` and `paused`.

export const WALLET_STATUSES = ['off', 'active', 'paused', 'frozen'] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

/** Why an admin paused or froze the wallet: a closed list, as an audit field holds no free text. */
export const WALLET_STATUS_REASONS = [
  'wind-down',
  'security-incident',
  'fraud-suspected',
  'legal-hold',
  'maintenance',
  'owner-decision',
] as const;
export type WalletStatusReason = (typeof WALLET_STATUS_REASONS)[number];

export const isWalletStatus = (value: unknown): value is WalletStatus =>
  typeof value === 'string' && (WALLET_STATUSES as readonly string[]).includes(value);

export const isStatusReason = (value: unknown): value is WalletStatusReason =>
  typeof value === 'string' && (WALLET_STATUS_REASONS as readonly string[]).includes(value);

/** `paused` and `frozen` always carry a reason; `off` and `active` carry none. */
export const needsReason = (status: WalletStatus): boolean =>
  status === 'paused' || status === 'frozen';

/** What an operation does to the customer's money. */
export type WalletOperation = 'grant' | 'hold' | 'capture' | 'release' | 'expire' | 'read';

export type StatusRefusal = 'wallet.disabled' | 'wallet.paused' | 'wallet.frozen';

const ALLOWED: Readonly<Record<WalletStatus, readonly WalletOperation[]>> = {
  off: [],
  active: ['grant', 'hold', 'capture', 'release', 'expire', 'read'],
  paused: ['capture', 'release', 'expire', 'read'],
  frozen: ['release', 'expire', 'read'],
};

/** Null when the operation may go ahead in this state, else the refusal code. */
export function refusalFor(status: WalletStatus, operation: WalletOperation): StatusRefusal | null {
  if (ALLOWED[status].includes(operation)) return null;
  return status === 'off'
    ? 'wallet.disabled'
    : status === 'paused'
      ? 'wallet.paused'
      : 'wallet.frozen';
}
