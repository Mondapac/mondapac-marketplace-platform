import type { ApiFailure } from '../api/client.ts';

export interface SaveProblem {
  /** A message key under `sellers`, for the form-level banner. */
  readonly form: { readonly key: string; readonly values?: Record<string, string | number> } | null;
  /** Field path (as the API names it) to a full message key. */
  readonly fields: Readonly<Record<string, string>>;
}

const FIELD_CODES = new Set(['required', 'characters', 'length', 'format', 'region']);

/** Codes that have their own message under `sellers.error`. */
const PLAIN = new Set([
  'lookup.limit',
  'conflict.stale',
  'file.change-request-required',
  'request.throttled',
]);

export function problemOf(failure: ApiFailure): SaveProblem {
  if (failure.code === 'validation.failed') {
    const fields: Record<string, string> = {};
    for (const problem of failure.details?.fields ?? []) {
      if (problem.path in fields) continue;
      fields[problem.path] = FIELD_CODES.has(problem.code)
        ? `sellers.validation.${problem.code}`
        : 'sellers.validation.invalid';
    }
    // A summary banner too: a problem on a path no input owns (the address as a whole) must
    // never leave the seller with no message at all.
    return { form: { key: 'sellers.validation.summary' }, fields };
  }
  if (failure.code === 'timezone.not-selectable') {
    return { form: null, fields: { timezone: 'sellers.error.timezone.not-selectable' } };
  }
  if (failure.code === 'phone.required') {
    return { form: null, fields: { phone: 'sellers.error.phone.required' } };
  }
  if (failure.code === 'identifier.format' || failure.code === 'identifier.checksum') {
    return { form: null, fields: { identifier: `sellers.error.${failure.code}` } };
  }
  if (
    failure.code === 'slug.taken' ||
    failure.code === 'slug.reserved' ||
    failure.code === 'slug.format'
  ) {
    return { form: null, fields: { slug: `sellers.error.${failure.code}` } };
  }
  if (failure.status === 503 || failure.code === 'sellers.unavailable') {
    return { form: { key: 'sellers.error.unavailable' }, fields: {} };
  }
  if (failure.code === 'request.csrf')
    return { form: { key: 'identity.error.request.csrf' }, fields: {} };
  if (PLAIN.has(failure.code))
    return { form: { key: `sellers.error.${failure.code}` }, fields: {} };
  return { form: { key: 'identity.error.unknown' }, fields: {} };
}
