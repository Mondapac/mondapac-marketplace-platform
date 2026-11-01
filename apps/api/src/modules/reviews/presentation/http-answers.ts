import { HttpException, type Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of a reviews route that every route shares: the error format
// `{ statusCode, code, details? }`, the closed JSON body and the status of each refusal. A
// refusal body never carries review text: codes and field paths only.

export const REVIEWS_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'reviews.not-eligible': 403,
  'reviews.own-store': 403,
  'reviews.disabled': 404,
  'reviews.not-found': 404,
  'reviews.window-closed': 409,
  'reviews.already-reviewed': 409,
  'reviews.already-rated': 409,
  'reviews.not-editable': 409,
  'reviews.edit-window-closed': 409,
  'reviews.not-moderatable': 409,
  'reviews.rate-limited': 429,
  'reviews.unavailable': 503,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
});

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** The JSON-only check and the closed object of a body: no key outside `allowed`, no array, no scalar. */
export function closedBody(
  request: Request,
  body: unknown,
  allowed: readonly string[] = [],
): HttpException | null {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed', { fields: [{ path: '', code: 'type' }] });
  }
  const unknown = Object.keys(body)
    .filter((key) => !allowed.includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  return unknown.length > 0 ? fail(400, 'validation.failed', { fields: unknown }) : null;
}

/** Query parameters nobody declared: refused, so a typo is not silently ignored. */
export function closedQuery(
  query: Record<string, unknown>,
  allowed: readonly string[],
): HttpException | null {
  const unknown = Object.keys(query)
    .filter((key) => !allowed.includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
      code: 'unknown-field',
    }));
  return unknown.length > 0 ? fail(400, 'validation.failed', { fields: unknown }) : null;
}

/** Turns a use case's refusal into the HTTP error; an unmapped code is a 500 and is logged. */
export function refusal(
  error: { readonly code: string } & Record<string, unknown>,
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    REVIEWS_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'reviews.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (error.details !== undefined) return fail(status, error.code, error.details as object);
  return fail(status, error.code);
}
