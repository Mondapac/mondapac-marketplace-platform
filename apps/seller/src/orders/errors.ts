import type { ApiFailure } from '../api/client.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'ordering.fulfilment-conflict': 'conflict',
  'ordering.seller-order-not-found': 'not-found',
  'validation.failed': 'invalid',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

/** Answers of "Mark unavailable" (message keys under `orders.unavailable.error`). */
const UNAVAILABLE_BY_CODE: Readonly<Record<string, string>> = {
  ...BY_CODE,
  'ordering.seller-order-refunded': 'refunded',
  'conflict.retry': 'refunded',
  'ordering.refund-limit-reached': 'limit-reached',
  'ordering.refund-limit-unset': 'limit-unset',
  'ordering.refund-disabled': 'disabled',
  'ordering.refund-not-allowed': 'not-allowed',
  'ordering.refund-in-progress': 'in-progress',
  'ordering.refund-exceeds': 'exceeds',
  'ordering.refund-tax-unknown': 'tax',
  'ordering.refund-tax-unavailable': 'tax',
  'ordering.refund-rejected': 'rejected',
};

export function unavailableProblemOf(failure: ApiFailure): string {
  const named = UNAVAILABLE_BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/** Answers that mean the page is out of date: the dialog closes and the page is read again. */
export const UNAVAILABLE_STALE: ReadonlySet<string> = new Set([
  'refunded',
  'conflict',
  'in-progress',
  'not-found',
]);

/** The message key (under `orders.error`) for a failed ready or deliver step. */
export function orderProblemOf(failure: ApiFailure): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
