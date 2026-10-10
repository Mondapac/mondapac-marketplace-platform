import type { ApiFailure } from '../api/client.ts';

export interface StockProblem {
  /** A message key under `stock`, for the form-level banner. */
  readonly form: { readonly key: string; readonly values?: Record<string, string | number> };
  /** Field name (`name`, `timeZone`, `address.<key>`) to a message key. */
  readonly fields: Readonly<Record<string, string>>;
}

const FIELD_CODES = new Set(['type', 'length', 'characters', 'fields', 'unknown']);

export function problemOf(failure: ApiFailure): StockProblem {
  if (failure.code === 'validation.failed') {
    const fields: Record<string, string> = {};
    for (const problem of failure.details?.fields ?? []) {
      if (problem.path in fields) continue;
      fields[problem.path] = FIELD_CODES.has(problem.code)
        ? `stock.validation.${problem.code}`
        : 'stock.validation.invalid';
    }
    return { form: { key: 'stock.validation.summary' }, fields };
  }
  if (failure.code === 'inventory.sources.limit-reached') {
    const max = (failure.details as { max?: number } | undefined)?.max;
    return {
      form: { key: 'stock.error.limit', ...(max === undefined ? {} : { values: { max } }) },
      fields: {},
    };
  }
  if (failure.code === 'conflict.stale') return { form: { key: 'stock.error.stale' }, fields: {} };
  if (failure.code === 'inventory.not-ready')
    return { form: { key: 'stock.error.not-ready' }, fields: {} };
  if (failure.code === 'access.denied') return { form: { key: 'stock.error.denied' }, fields: {} };
  if (failure.code === 'request.throttled')
    return { form: { key: 'stock.error.throttled' }, fields: {} };
  if (failure.code === 'request.csrf')
    return { form: { key: 'identity.error.request.csrf' }, fields: {} };
  if (failure.status === 503 || failure.status === 0)
    return { form: { key: 'stock.error.unavailable' }, fields: {} };
  return { form: { key: 'identity.error.unknown' }, fields: {} };
}
