import type { ApiFailure } from '../api/client.ts';

/** The screens a refusal is shown on; a few codes read differently on each. */
export type WalletContext = 'settings' | 'issue' | 'decide';

const COMMON: Readonly<Record<string, string>> = {
  'wallet.cannot-turn-off-with-history': 'cannot-turn-off-with-history',
  'wallet.busy': 'busy',
  'wallet.disabled': 'disabled',
  'wallet.paused': 'paused',
  'wallet.frozen': 'frozen',
  'wallet.cap-exceeded': 'cap-exceeded',
  'wallet.account-not-active': 'account-not-active',
  'wallet.customer-not-found': 'customer-not-found',
  'wallet.approver-is-requester': 'approver-is-requester',
  'wallet.credit-request-decided': 'request-decided',
  'wallet.credit-request-expired': 'request-expired',
  'wallet.credit-request-not-found': 'request-not-found',
  'idempotency.key-reused': 'key-reused',
  'validation.failed': 'validation',
  'access.denied': 'denied',
  'request.csrf': 'session',
};

/** The message key (under `wallet.error`) for a failed wallet call. Unknown codes read as unknown. */
export function walletProblemOf(failure: ApiFailure, context: WalletContext): string {
  const named = COMMON[failure.code];
  if (named !== undefined) {
    if (named === 'denied' || named === 'validation') return `${named}-${context}`;
    if (context === 'decide' && ['paused', 'frozen', 'disabled'].includes(named)) {
      return 'not-active';
    }
    if (context === 'decide' && named === 'cap-exceeded') return 'cap-exceeded-decide';
    return named;
  }
  if (
    failure.code === 'wallet.unavailable' ||
    failure.code === 'access.unavailable' ||
    failure.status === 503 ||
    failure.status === 0
  ) {
    return context === 'settings' ? 'save-failed' : `unavailable-${context}`;
  }
  return 'unknown';
}

/** Refusals the same request may be sent again after (the answer was not final). */
export function isRetryable(failure: ApiFailure): boolean {
  return (
    failure.status === 0 ||
    failure.status === 503 ||
    failure.code === 'wallet.unavailable' ||
    failure.code === 'access.unavailable'
  );
}

/** The field a `validation.failed` path points at (last segment of the path), or null. */
export function failedFields(failure: ApiFailure): readonly string[] {
  return (failure.details?.fields ?? []).map((field) => field.path.split('.').pop() ?? field.path);
}
