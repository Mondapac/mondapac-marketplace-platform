import type { ApiFailure } from '../api/client.ts';

/** A message key under `business-activities.error` for a refused call. */
const BY_CODE: Readonly<Record<string, string>> = {
  'validation.failed': 'invalid',
  'business-activity.claim-word': 'claim-word',
  'business-activity.code-taken': 'code-taken',
  'business-activity.name-taken': 'name-taken',
  'business-activity.not-found': 'gone',
  'conflict.stale': 'stale',
  'conflict.retry': 'retry',
  'access.denied': 'denied',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
};

export interface ActivityField {
  /** Path the API refused: `names.<locale>`, `description`, `code`, `categoryIds`, ... */
  readonly path: string;
  /** The API's reason (`claim-word`, `too-long`, `taken`, ...). */
  readonly code: string;
}

export interface ActivityProblem {
  /** Full message key. */
  readonly key: string;
  /** The activity changed or vanished meanwhile: the list is read again. */
  readonly reload: boolean;
  readonly fields: readonly ActivityField[];
}

export function activityProblemOf(failure: ApiFailure): ActivityProblem {
  const named = BY_CODE[failure.code];
  const key = named ?? (failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown');
  const fields: ActivityField[] = (failure.details?.fields ?? []).map((field) => ({
    path: field.path,
    code: field.code,
  }));
  if (failure.code === 'business-activity.code-taken') fields.push({ path: 'code', code: 'taken' });
  return {
    key: `business-activities.error.${key}`,
    reload: key === 'gone' || key === 'stale',
    fields,
  };
}
