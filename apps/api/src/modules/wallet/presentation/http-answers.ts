import { HttpException, type Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of a wallet route that every route shares: the error format
// `{ statusCode, code, details? }`, the closed JSON body and the status of each refusal.

export const WALLET_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'wallet.disabled': 404,
  'wallet.unavailable': 503,
  'wallet.cannot-turn-off-with-history': 409,
  'wallet.busy': 409,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  // Admin credit issuance (package 2a).
  'wallet.paused': 409,
  'wallet.frozen': 409,
  'wallet.cap-exceeded': 409,
  'wallet.account-not-active': 409,
  'idempotency.key-reused': 409,
  'wallet.credit-request-not-found': 404,
  'wallet.customer-not-found': 404,
  'wallet.credit-request-decided': 409,
  'wallet.credit-request-expired': 409,
  'wallet.approver-is-requester': 403,
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

/** A query `limit`: digits only, else a value the use case refuses. */
export const parseLimit = (value: unknown): number | undefined =>
  value === undefined
    ? undefined
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value)
      ? Number(value)
      : -1;

/** Turns a use case's refusal into the HTTP error; an unmapped code is a 500 and is logged. */
export function refusal(
  error: { readonly code: string } & Record<string, unknown>,
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    WALLET_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'wallet.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (typeof error.actionKey === 'string') {
    return fail(status, error.code, { actionKey: error.actionKey });
  }
  return fail(status, error.code);
}
