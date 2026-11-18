import type { ApiFailure } from '../../api/client.ts';

/** A message key under `certificates.types.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'type.not-found': 'gone',
  'type.already-inactive': 'already-inactive',
  'type.already-active': 'already-active',
  'proposal.not-found': 'proposal-gone',
  'review.proposal-pending': 'proposal-pending',
  'review.proposal-closed': 'proposal-closed',
  'review.second-admin-required': 'second-admin',
  'review.proposer-cannot-reject': 'second-admin',
  'review.not-proposer': 'not-proposer',
  'type.revision-unchanged': 'unchanged',
  'type.revision-invalid': 'revision-invalid',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'access.acting-as-refused': 'acting-as',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface TypeProblem {
  /** Full message key. */
  readonly key: string;
  /** The type changed or vanished meanwhile: the page is read again. */
  readonly reload: boolean;
  /** For a refused revision: the keys under `certificates.types.revise.issue`, once each. */
  readonly issues: readonly string[];
}

const ISSUES: Readonly<Record<string, string>> = {
  'type.text-invalid': 'text-invalid',
  'type.claim-term-unmatchable': 'term-unmatchable',
  'type.claim-terms-missing': 'terms-missing',
  'type.badge-icon-invalid': 'icon',
  'type.locale-missing': 'locale',
  'type.locale-not-supported': 'locale',
  'type.auto-approve-needs-self-declaration': 'auto',
  'type.verification-mode-immutable': 'mode',
  'type.default-basis-invalid': 'basis',
};

const RELOAD = new Set([
  'stale',
  'gone',
  'already-inactive',
  'already-active',
  'proposal-gone',
  'proposal-pending',
  'proposal-closed',
]);

export function typeProblemOf(failure: ApiFailure): TypeProblem {
  const named = Object.hasOwn(BY_CODE, failure.code) ? BY_CODE[failure.code] : undefined;
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  const issues = new Set<string>();
  for (const issue of failure.details?.issues ?? []) {
    const named = Object.hasOwn(ISSUES, issue.code) ? ISSUES[issue.code] : undefined;
    if (named !== undefined) issues.add(named);
  }
  return {
    key: `certificates.types.error.${key}`,
    reload: RELOAD.has(key),
    issues: [...issues],
  };
}
