import type { ApiFailure } from '../api/client.ts';

export interface DeliveryProblem {
  /** A message key, for the form-level banner. */
  readonly form: string;
  /** Field name (`delivery.day`, `delivery.from`, ...) to a message key. */
  readonly fields: Readonly<Record<string, string>>;
}

const REFUSED_FIELD: Readonly<Record<string, { path: string; key: string }>> = {
  'delivery.day': { path: 'delivery.day', key: 'delivery.validation.day' },
  'delivery.window': { path: 'delivery.to', key: 'delivery.validation.window' },
  'delivery.cutoff': { path: 'delivery.cutoff', key: 'delivery.validation.cutoff' },
};

export function problemOf(failure: ApiFailure): DeliveryProblem {
  const refused = REFUSED_FIELD[failure.code];
  if (refused !== undefined) {
    return { form: 'delivery.validation.summary', fields: { [refused.path]: refused.key } };
  }
  if (failure.code === 'validation.failed') {
    return { form: 'delivery.validation.summary', fields: {} };
  }
  if (failure.code === 'conflict.stale') return { form: 'delivery.error.stale', fields: {} };
  if (failure.code === 'access.denied') return { form: 'delivery.error.denied', fields: {} };
  if (failure.code === 'request.throttled') return { form: 'delivery.error.throttled', fields: {} };
  if (failure.code === 'request.csrf') return { form: 'identity.error.request.csrf', fields: {} };
  if (failure.status === 503 || failure.status === 0) {
    return { form: 'delivery.error.unavailable', fields: {} };
  }
  return { form: 'identity.error.unknown', fields: {} };
}
