import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import { WALLET_STATUS_REASONS, WALLET_STATUSES } from './wallet-status';

// The audited action of wallet (the Market switch), registered at boot with
// `registerAuditActions('wallet', WALLET_AUDIT_ACTIONS)`. An audit field holds no free text, so a
// reason is one of the closed codes of WALLET_STATUS_REASONS.

/** The audit target type of the wallet switch. */
export const WALLET_SETTINGS_TARGET = 'wallet.market-settings';

/**
 * An admin moved the Market's wallet to another state. `after` names the admin step-up proof the
 * change spent (issue #491; Hassan L3): the session that verified the code and when.
 */
export const WalletStatusChanged = defineAuditAction({
  action: 'wallet.market-status.changed',
  targetType: WALLET_SETTINGS_TARGET,
  targetId: auditField.enumOf(['wallet-settings'] as const),
  actors: ['authenticated'],
  before: {
    status: auditField.enumOf(WALLET_STATUSES),
    reason: auditField.optional(auditField.enumOf(WALLET_STATUS_REASONS)),
  },
  after: {
    status: auditField.enumOf(WALLET_STATUSES),
    reason: auditField.optional(auditField.enumOf(WALLET_STATUS_REASONS)),
    stepUpSessionId: auditField.id(),
    stepUpVerifiedAt: auditField.instant(),
  },
});

export const WALLET_AUDIT_ACTIONS = [WalletStatusChanged] as const;
