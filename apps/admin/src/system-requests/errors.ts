import type { BannerTone } from '@mondapac/ui';
import type { ApiFailure } from '../api/client.ts';

/** What a refused decision, comment or policy save says, and what the page may offer beside it. */
export interface Refusal {
  readonly tone: BannerTone;
  /** The message under `system-requests.refusal.<key>`. */
  readonly key: string;
  /** `changed-since`: the later request, for the "Open the newer request" link. */
  readonly newerRequestId?: string;
  /** The page offers Try again (the work can be repeated safely). */
  readonly retry?: boolean;
  /** The page offers a link to the profile (two-step setup). */
  readonly enrol?: boolean;
  /** The page offers a reload (the session's token expired). */
  readonly reload?: boolean;
  /** The request changed under the admin: load it again. */
  readonly refetch: boolean;
}

const PREFIX = 'system-requests.';

/** A code without the module prefix: "system-requests.own-request" -> "own-request". */
export const shortCode = (code: string): string =>
  code.startsWith(PREFIX) ? code.slice(PREFIX.length) : code;

/**
 * The refusal of a decision (approve, reject, withdraw), one message per cause (screens spec,
 * "Outcome messages"). `own-subject` is a planned code; both own codes read the same.
 */
export function refusalOf(failure: ApiFailure): Refusal {
  const code = shortCode(failure.code);
  switch (code) {
    case 'changed-since':
      return {
        tone: 'attention',
        key: 'changed-since',
        ...(typeof failure.details?.newerRequestId === 'string'
          ? { newerRequestId: failure.details.newerRequestId }
          : {}),
        refetch: true,
      };
    case 'subject-gone':
      return { tone: 'attention', key: 'subject-gone', refetch: true };
    case 'revert-not-permitted':
      return { tone: 'critical', key: 'revert-not-permitted', refetch: true };
    case 'own-request':
    case 'own-subject':
      return { tone: 'critical', key: 'own', refetch: true };
    case 'not-author':
      return { tone: 'critical', key: 'not-author', refetch: true };
    case 'not-reviewer':
      return { tone: 'critical', key: 'not-reviewer', refetch: true };
    case 'decided':
      return { tone: 'info', key: 'decided', refetch: true };
    case 'revert-unavailable':
      return { tone: 'critical', key: 'revert-unavailable', retry: true, refetch: false };
    case 'not-found':
      return { tone: 'critical', key: 'not-found', refetch: false };
    case 'second-factor.enrolment-required':
      return { tone: 'critical', key: 'enrol', enrol: true, refetch: false };
    case 'access.denied':
    case 'second-factor.required':
      return { tone: 'critical', key: 'denied', refetch: false };
    case 'request.csrf':
      return { tone: 'critical', key: 'csrf', reload: true, refetch: false };
    case 'network':
      return { tone: 'critical', key: 'network', retry: true, refetch: false };
    default:
      if (failure.status === 403) return { tone: 'critical', key: 'denied', refetch: false };
      if (failure.status === 503) {
        return { tone: 'critical', key: 'revert-unavailable', retry: true, refetch: false };
      }
      return { tone: 'critical', key: 'unknown', retry: true, refetch: false };
  }
}

/** The reasons a bulk approve skips a request, as the keys of `system-requests.bulk.reason`. */
export function bulkReasonKey(code: string): string {
  switch (shortCode(code)) {
    case 'not-low-risk':
      return 'not-low-risk';
    case 'decided':
      return 'decided';
    case 'own-request':
    case 'own-subject':
      return 'own';
    case 'not-reviewer':
      return 'not-reviewer';
    case 'one-by-one':
      return 'one-by-one';
    case 'not-found':
      return 'not-found';
    default:
      return 'other';
  }
}

/** True when a 400 names the field, so the field (not the page) shows the error. */
export function isFieldFailure(failure: ApiFailure, field: string): boolean {
  return (
    failure.status === 400 &&
    failure.code === 'validation.failed' &&
    (failure.details?.fields ?? []).some((entry) => entry.path === field)
  );
}

/** A change of any request on these pages: the menu badge and open lists load again. */
export const CHANGED_EVENT = 'mp-system-requests-changed';

export function notifyChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED_EVENT));
}
