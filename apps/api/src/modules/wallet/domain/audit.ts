import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import {
  ADMIN_CREDIT_REASONS,
  ADMIN_CREDIT_REJECT_REASONS,
  APPROVAL_REASONS,
} from './admin-credit';
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

/** The audit target type of an admin credit issue or request (package 2a); the target id is its id. */
export const ADMIN_CREDIT_TARGET = 'wallet.admin-credit-request';

const stepUp = { stepUpSessionId: auditField.id(), stepUpVerifiedAt: auditField.instant() };
const issue = {
  customerAccountId: auditField.id(),
  amount: auditField.money(),
  reasonCode: auditField.enumOf(ADMIN_CREDIT_REASONS),
};

/** An admin issued credit within both caps: granted at once, with the journal it wrote. */
export const AdminCreditIssued = defineAuditAction({
  action: 'wallet.admin-credit.issued',
  targetType: ADMIN_CREDIT_TARGET,
  actors: ['authenticated'],
  after: {
    ...issue,
    status: auditField.enumOf(['granted'] as const),
    journalId: auditField.id(),
    ...stepUp,
  },
});

/** An admin asked for credit above a cap: a pending request for a second admin. */
export const AdminCreditRequested = defineAuditAction({
  action: 'wallet.admin-credit.requested',
  targetType: ADMIN_CREDIT_TARGET,
  actors: ['authenticated'],
  after: {
    ...issue,
    status: auditField.enumOf(['pending'] as const),
    approvalReason: auditField.enumOf(APPROVAL_REASONS),
    expiresAt: auditField.instant(),
    ...stepUp,
  },
});

/** A second admin approved a pending request and the credit was granted. */
export const AdminCreditApproved = defineAuditAction({
  action: 'wallet.admin-credit.approved',
  targetType: ADMIN_CREDIT_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['pending'] as const) },
  after: {
    status: auditField.enumOf(['approved'] as const),
    requestedBy: auditField.id(),
    customerAccountId: auditField.id(),
    amount: auditField.money(),
    journalId: auditField.id(),
    ...stepUp,
  },
});

/** A second admin rejected a pending request; no money moved. */
export const AdminCreditRejected = defineAuditAction({
  action: 'wallet.admin-credit.rejected',
  targetType: ADMIN_CREDIT_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['pending'] as const) },
  after: {
    status: auditField.enumOf(['rejected'] as const),
    requestedBy: auditField.id(),
    reasonCode: auditField.enumOf(ADMIN_CREDIT_REJECT_REASONS),
    ...stepUp,
  },
});

/** Nobody decided a pending request in time; the worker's sweep expired it. No money moved. */
export const AdminCreditExpired = defineAuditAction({
  action: 'wallet.admin-credit.expired',
  targetType: ADMIN_CREDIT_TARGET,
  actors: ['system'],
  before: { status: auditField.enumOf(['pending'] as const) },
  after: { status: auditField.enumOf(['expired'] as const), requestedBy: auditField.id() },
});

export const WALLET_AUDIT_ACTIONS = [
  WalletStatusChanged,
  AdminCreditIssued,
  AdminCreditRequested,
  AdminCreditApproved,
  AdminCreditRejected,
  AdminCreditExpired,
] as const;
