import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  PasswordChanged,
  PasswordConfirmFailed,
  PasswordReset,
  SecondFactorFailed,
  SecondFactorLocked,
  SignInFailed,
  SignInSucceeded,
  SignInThrottled,
  type SecurityEventInput,
} from '../../../platform/security-events/security-event-catalogue';
import type { SecurityEvents } from '../../../platform/security-events/security-events';

/** The populations of identity's security events. */
export type SecurityPopulation = 'customer' | 'seller' | 'admin';

/** One sign-in record's facts (identity design 10.2), as the security event reads them. */
export interface SignInOutcome {
  readonly population: SecurityPopulation;
  readonly accountId: Id<'Account'> | null;
  /** The outcome code of the sign-in record. */
  readonly outcome: string;
  readonly sessionId: Id<'Session'> | null;
  /** The client's full address, as the sign-in record keeps it. */
  readonly address: string;
}

const FAILED_REASONS = {
  'credentials.invalid': 'credentials-invalid',
  'link.rejected': 'link-rejected',
  'challenge.rejected': 'challenge-rejected',
  'account.disabled': 'account-disabled',
} as const;

/**
 * The security event of a sign-in record's outcome (SOC package 1;
 * docs/design/data/platform.md 13.2.1), or null for an outcome that is not one:
 * a step towards a session (a challenge issued, a factor enrolment started), a refusal of the
 * account's own state that is not an attack signal (email not verified, no membership), a busy
 * hasher. The address goes with the event; the email, the password and the code never do.
 */
export function securityEventOfSignIn(record: SignInOutcome): SecurityEventInput | null {
  const { population, accountId, outcome, address } = record;
  const ip = address;
  if (outcome === 'signed-in') {
    if (accountId === null || record.sessionId === null) return null;
    return SignInSucceeded.event({
      targetId: accountId,
      ip,
      payload: { population, sessionId: record.sessionId },
    });
  }
  if (outcome === 'request.throttled') {
    return SignInThrottled.event({ targetId: accountId, ip, payload: { population } });
  }
  if (Object.hasOwn(FAILED_REASONS, outcome)) {
    const reason = FAILED_REASONS[outcome as keyof typeof FAILED_REASONS];
    return SignInFailed.event({ targetId: accountId, ip, payload: { population, reason } });
  }
  // The remaining types are about one known account.
  if (accountId === null) return null;
  const definition =
    outcome === 'second-factor.invalid'
      ? SecondFactorFailed
      : outcome === 'second-factor.locked'
        ? SecondFactorLocked
        : outcome === 'password.current-incorrect'
          ? PasswordConfirmFailed
          : outcome === 'password-changed'
            ? PasswordChanged
            : outcome === 'password-reset'
              ? PasswordReset
              : null;
  return definition === null
    ? null
    : definition.event({ targetId: accountId, ip, payload: { population } });
}

/**
 * Records the security event of a sign-in record, in the caller's unit, next to the record
 * itself: every place that adds a sign-in record calls this right after it.
 */
export async function recordSignInSecurityEvent(
  securityEvents: SecurityEvents,
  context: CallContext,
  record: SignInOutcome,
): Promise<void> {
  const event = securityEventOfSignIn(record);
  if (event !== null) await securityEvents.record(context, event);
}
