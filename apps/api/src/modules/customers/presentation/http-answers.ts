import { HttpException, type Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of an address book route that every route shares: the error format
// `{ statusCode, code, details? }`, the closed JSON body and the status of each refusal.

export const CUSTOMERS_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'customers.address-not-found': 404,
  'customers.address-limit-reached': 422,
  'customers.conflict': 409,
  'customers.account-deletion-disabled': 403,
  'customers.account-deletion-blocked': 409,
  'customers.account-deletion-already-requested': 409,
  'customers.account-deletion-request-not-found': 404,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  'customers.unavailable': 503,
});

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** The JSON-only check and the closed object of a body: no key outside `allowed`, no array, no scalar. */
export function closedBody(
  request: Request,
  body: unknown,
  allowed: readonly string[],
): HttpException | null {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed', { fields: [{ path: '', code: 'type' }] });
  }
  return closedObject(body, allowed, '');
}

/** A nested object of a body, closed the same way; paths are prefixed with `prefix`. */
export function closedObject(
  value: unknown,
  allowed: readonly string[],
  prefix: string,
): HttpException | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(400, 'validation.failed', { fields: [{ path: prefix, code: 'type' }] });
  }
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort()
    .slice(0, 10)
    .map((key) => ({
      path: `${prefix === '' ? '' : `${prefix}.`}${Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�')}`,
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
    CUSTOMERS_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'customers.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (Array.isArray(error.blockers)) return fail(status, error.code, { blockers: error.blockers });
  if (typeof error.actionKey === 'string') {
    return fail(status, error.code, { actionKey: error.actionKey });
  }
  if (error.limit !== undefined) return fail(status, error.code, { limit: error.limit });
  return fail(status, error.code);
}
