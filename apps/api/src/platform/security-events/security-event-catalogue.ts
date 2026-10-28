import { eventField } from '@mondapac/shared-kernel';
import type { PayloadFields, PayloadOf } from '@mondapac/shared-kernel';

// The closed catalogue of security events (SOC package 1;
// docs/design/data/platform.md 13.2). Two kinds of entry:
// - a recorded type, written by its owner through `SecurityEvents.record` (a sign-in outcome, a
//   second-factor failure, a webhook whose signature failed);
// - a projected audit action: a security-relevant action that is already audited (a role, a
//   switch, a payout account). The audit writer writes its security event itself, in the same
//   unit as the audit row, so no use case can forget it. Its payload is the audit row's id only:
//   the details stay in the audit log, behind its own permission.
// A new type, a changed field or severity is reviewed by the security-tester (snapshot in
// apps/api/test/contracts/security-event-catalogue.snapshot.json).

/** Plan section 4: s1 critical (24/7), s2 high, s3 medium, s4 low. */
export type SecuritySeverity = 's1' | 's2' | 's3' | 's4';

export const SECURITY_SEVERITIES: readonly SecuritySeverity[] = Object.freeze([
  's1',
  's2',
  's3',
  's4',
]);

/** The population of an identity event: who was signing in. */
const population = eventField.enumOf(['customer', 'seller', 'admin'] as const);

/** One recorded type. `F` is its payload; never a secret, an email or free text (P 5.3). */
export interface SecurityEventDefinition<F extends PayloadFields = PayloadFields> {
  /** `<owner>.<subject>.<verb>`. */
  readonly type: string;
  /** The first segment of the type: the module (or `platform.<component>`) that records it. */
  readonly owner: string;
  readonly severity: SecuritySeverity;
  /**
   * The target type an event names (an account), or null for none. With `targetRequired`
   * false the target may be absent (a failed sign-in for an unknown address names none).
   */
  readonly targetType: string | null;
  readonly targetRequired: boolean;
  /** Whether the client address is kept (plan 3: only where needed to follow an attack up). */
  readonly ip: boolean;
  readonly payload: F;
  /** The input of `SecurityEvents.record` for this type. */
  event(values: SecurityEventValues<F>): SecurityEventInput;
}

/** What a caller passes to build one event of a definition. */
export interface SecurityEventValues<F extends PayloadFields> {
  readonly targetId?: string | null;
  /** The client address as resolved per ADR-0037; only on a type that declares `ip`. */
  readonly ip?: string | null;
  readonly payload: PayloadOf<F>;
}

/** The input of `SecurityEvents.record`: built by a definition's `event`, checked by the writer. */
export interface SecurityEventInput {
  readonly type: string;
  readonly targetId: string | null;
  readonly ip: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

const TYPE = /^([a-z][a-z0-9-]*)\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

function defineSecurityEvent<const F extends PayloadFields>(declaration: {
  readonly type: string;
  readonly severity: SecuritySeverity;
  readonly targetType: string | null;
  readonly targetRequired?: boolean;
  readonly ip: boolean;
  readonly payload: F;
}): SecurityEventDefinition<F> {
  const parts = TYPE.exec(declaration.type);
  if (parts === null) throw new TypeError(`"${declaration.type}" is not a security event type`);
  const targetRequired = declaration.targetType !== null && declaration.targetRequired !== false;
  return Object.freeze({
    type: declaration.type,
    owner: parts[1]!,
    severity: declaration.severity,
    targetType: declaration.targetType,
    targetRequired,
    ip: declaration.ip,
    payload: declaration.payload,
    event: (values: SecurityEventValues<F>): SecurityEventInput =>
      Object.freeze({
        type: declaration.type,
        targetId: values.targetId ?? null,
        ip: values.ip ?? null,
        payload: values.payload,
      }),
  });
}

// ---------------------------------------------------------------------------------------------
// Recorded types

/** A session was opened (any population; an admin's after the second factor). */
export const SignInSucceeded = defineSecurityEvent({
  type: 'identity.sign-in.succeeded',
  severity: 's4',
  targetType: 'account',
  ip: true,
  payload: { population, sessionId: eventField.id() },
});

/** A sign-in attempt was refused before a session (the password, the link, the account state). */
export const SignInFailed = defineSecurityEvent({
  type: 'identity.sign-in.failed',
  severity: 's4',
  targetType: 'account',
  targetRequired: false,
  ip: true,
  payload: {
    population,
    reason: eventField.enumOf([
      'credentials-invalid',
      'link-rejected',
      'challenge-rejected',
      'account-disabled',
    ] as const),
  },
});

/** A sign-in or code attempt met a counter at its limit (identity design 6.8). */
export const SignInThrottled = defineSecurityEvent({
  type: 'identity.sign-in.throttled',
  severity: 's3',
  targetType: 'account',
  targetRequired: false,
  ip: true,
  payload: { population },
});

/** A wrong second-factor code (sign-in challenge, step-up or password change). */
export const SecondFactorFailed = defineSecurityEvent({
  type: 'identity.second-factor.failed',
  severity: 's3',
  targetType: 'account',
  ip: true,
  payload: { population },
});

/** The account's code attempts reached their limit: the factor is locked for a while. */
export const SecondFactorLocked = defineSecurityEvent({
  type: 'identity.second-factor.locked',
  severity: 's2',
  targetType: 'account',
  ip: true,
  payload: { population },
});

/** The current password was wrong where it is asked again (password change, factor enrolment). */
export const PasswordConfirmFailed = defineSecurityEvent({
  type: 'identity.password.confirm-failed',
  severity: 's4',
  targetType: 'account',
  ip: true,
  payload: { population },
});

/** The account holder changed the password (the other sessions are signed out). */
export const PasswordChanged = defineSecurityEvent({
  type: 'identity.password.changed',
  severity: 's3',
  targetType: 'account',
  ip: true,
  payload: { population },
});

/** The password was set again through a reset link (every session is signed out). */
export const PasswordReset = defineSecurityEvent({
  type: 'identity.password.reset',
  severity: 's3',
  targetType: 'account',
  ip: true,
  payload: { population },
});

/** A Stripe webhook whose signature did not verify (plan 3: forged webhooks). */
export const StripeWebhookSignatureFailed = defineSecurityEvent({
  type: 'payments.webhook-signature.failed',
  severity: 's3',
  targetType: null,
  ip: true,
  payload: { provider: eventField.enumOf(['stripe'] as const) },
});

/**
 * A Stripe dispute payments could not record (package 8a): unreadable, not test mode, no Market on
 * its PaymentIntent, malformed, or a later read that changes its order or amount. Its money may
 * move all the same, so an admin looks at it in the Stripe Dashboard.
 */
export const StripeDisputeUnmatched = defineSecurityEvent({
  type: 'payments.dispute.unmatched',
  severity: 's2',
  targetType: null,
  ip: false,
  payload: {
    reason: eventField.enumOf([
      'unreadable',
      'not-test-mode',
      'no-market',
      'malformed',
      'changed',
    ] as const),
  },
});

/**
 * An alert of the transfer execution (package 6c): an amount above the Market's ceiling, an
 * insufficient platform balance, a day's executed total above its threshold, a transfer found for
 * a key that was abandoned (fence breach), a partial match, a stored key version whose key is
 * missing, or a Stripe transfer payments cannot match to a stored row. Ids and a code only.
 */
export const TransferAlert = defineSecurityEvent({
  type: 'payments.transfer.alert',
  severity: 's2',
  targetType: 'payments.connected-account',
  targetRequired: false,
  ip: false,
  payload: {
    kind: eventField.enumOf([
      'amount-out-of-range',
      'insufficient-platform-balance',
      'daily-total-over-threshold',
      'fence-breached',
      'partial-match',
      'hmac-key-missing',
      'transfer-unmatched',
    ] as const),
  },
});

/**
 * A dispute payments recorded names an order that commission-payouts cannot match (package 8b):
 * the order is unknown in this Market, or the dispute's PaymentIntent is not the order's own. Its
 * money may move all the same, so it holds nothing and an admin looks at it in the Stripe
 * Dashboard.
 */
export const DisputeOrderMismatch = defineSecurityEvent({
  type: 'commission-payouts.dispute.order-mismatch',
  severity: 's2',
  targetType: null,
  ip: false,
  payload: {
    disputeId: eventField.id(),
    reason: eventField.enumOf([
      'unknown-order',
      'payment-intent-mismatch',
      'order-changed',
    ] as const),
  },
});

/**
 * The live read of a connected account before a transfer failed (package 6c, HP-1 condition 2):
 * the transfer was not made and nothing else changed. This is the counter behind
 * `payments_live_check_failures_total{market}`: Kazem's rule counts these per Market.
 */
export const LiveCheckFailed = defineSecurityEvent({
  type: 'payments.live-check.failed',
  severity: 's3',
  targetType: 'payments.connected-account',
  targetRequired: false,
  ip: false,
  payload: { reason: eventField.enumOf(['provider-unavailable'] as const) },
});

/** A carrier webhook whose signature did not verify (Mondapac Drive; Uber Direct and Zoom2u when built). */
export const CarrierWebhookSignatureFailed = defineSecurityEvent({
  type: 'shipping.webhook-signature.failed',
  severity: 's3',
  targetType: null,
  ip: true,
  payload: { carrier: eventField.enumOf(['mondapac-drive', 'uber-direct', 'zoom2u'] as const) },
});

/** Every recorded type, by type. */
export const RECORDED_SECURITY_EVENTS: ReadonlyMap<string, SecurityEventDefinition> = new Map(
  (
    [
      SignInSucceeded,
      SignInFailed,
      SignInThrottled,
      SecondFactorFailed,
      SecondFactorLocked,
      PasswordConfirmFailed,
      PasswordChanged,
      PasswordReset,
      StripeWebhookSignatureFailed,
      StripeDisputeUnmatched,
      TransferAlert,
      LiveCheckFailed,
      DisputeOrderMismatch,
      CarrierWebhookSignatureFailed,
    ] as readonly SecurityEventDefinition[]
  ).map((definition) => [definition.type, definition]),
);

// ---------------------------------------------------------------------------------------------
// Projected audit actions

/**
 * The audited actions that also make a security event, with its severity (plan sections 2 and
 * 4): admin roles and permissions, account status and second factors, the Market switches
 * (wallet, tax strategy, assistant), payout accounts and schedules, commission rates, refunds,
 * and the support contact. The event's type is the action; its target
 * is the audit row's; its payload is `{ auditLogId }`.
 */
export const AUDITED_SECURITY_ACTIONS: ReadonlyMap<string, SecuritySeverity> = new Map<
  string,
  SecuritySeverity
>([
  ['identity.role.created', 's3'],
  ['identity.role.updated', 's3'],
  ['identity.role.deleted', 's3'],
  ['identity.account-role.assigned', 's2'],
  ['identity.account-role.changed', 's2'],
  ['identity.account.disabled', 's3'],
  ['identity.account.enabled', 's3'],
  ['identity.account.other-sessions-signed-out', 's4'],
  ['identity.invitation.issued', 's3'],
  ['identity.invitation.accepted', 's3'],
  ['identity.second-factor.activated', 's3'],
  ['identity.second-factor.replaced', 's3'],
  ['identity.second-factor.recovery-codes-regenerated', 's3'],
  ['identity.second-factor.reset', 's2'],
  ['identity.seller-second-factor-reset.confirmed', 's2'],
  ['identity.seller-member.added', 's4'],
  ['identity.seller-member.removed', 's4'],
  ['identity.seller-step-up-policy.changed', 's3'],
  ['wallet.market-status.changed', 's2'],
  ['tax.strategy.activate', 's2'],
  ['tax.strategy.deactivate', 's2'],
  ['assistant.settings.changed', 's3'],
  ['payments.payout-change.recorded', 's2'],
  ['payments.payout-schedule.paused', 's2'],
  ['payments.payout-schedule.resumed', 's2'],
  ['payments.payout-pause.failed', 's2'],
  ['commission-payouts.commission-rate.set', 's3'],
  ['commission-payouts.commission-rate.clear', 's3'],
  ['ordering.refund.requested', 's3'],
  ['notifications.support-contact.changed', 's3'],
]);

/** The payload of a projected event: the audit row it comes from. */
export const PROJECTED_PAYLOAD = Object.freeze({ auditLogId: eventField.id() });

for (const type of RECORDED_SECURITY_EVENTS.keys()) {
  // One meaning per type: a recorded type never shares its name with a projected action.
  if (AUDITED_SECURITY_ACTIONS.has(type)) {
    throw new Error(`Security event "${type}" is both recorded and projected`);
  }
}
for (const severity of AUDITED_SECURITY_ACTIONS.values()) {
  if (!SECURITY_SEVERITIES.includes(severity)) throw new Error('Unknown security severity');
}
