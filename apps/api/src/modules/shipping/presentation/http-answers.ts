import { HttpException, type Logger } from '@nestjs/common';
import type { CallContext, Money } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of a shipping route that every route shares: the error format
// `{ statusCode, code, details? }`, the closed JSON body and the status of each refusal.

export const SHIPPING_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'shipping.seller-not-found': 404,
  'shipping.fee-not-set': 404,
  'shipping.store-fee-not-found': 404,
  'shipping.fleet-model-not-found': 404,
  'shipping.fleet-model-name-taken': 409,
  'shipping.fleet-model-conflict': 409,
  'shipping.delivery-settings-conflict': 409,
  'shipping.unavailable': 503,
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

export const moneyBody = (value: Money) => ({
  amount: value.amount.toString(),
  currency: value.currency,
});

/** Turns a use case's refusal into the HTTP error; an unmapped code is a 500 and is logged. */
export function refusal(
  error: { readonly code: string } & Record<string, unknown>,
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    SHIPPING_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'shipping.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (typeof error.currency === 'string')
    return fail(status, error.code, { currency: error.currency });
  return fail(status, error.code);
}
