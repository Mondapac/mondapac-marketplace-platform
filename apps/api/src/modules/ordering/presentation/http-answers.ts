import { HttpException, type Logger } from '@nestjs/common';
import type { CallContext, Money } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of an ordering route that every route shares: the error format
// `{ statusCode, code, details? }`, the closed JSON body, the status of each refusal and the
// wire shape of money and orders.

/** The HTTP status of each refusal of the ordering routes. */
export const ORDERING_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'ordering.order-not-found': 404,
  'ordering.address-not-found': 422,
  'ordering.cart-empty': 422,
  'ordering.cart-not-purchasable': 422,
  'ordering.stock-insufficient': 409,
  'ordering.cart-not-ready': 409,
  'conflict.retry': 409,
  'request.throttled': 429,
  'ordering.check-unavailable': 503,
  'ordering.shipping-unavailable': 503,
  'ordering.seller-order-not-found': 404,
  'ordering.fulfilment-conflict': 409,
  'ordering.payment-unavailable': 503,
  'ordering.refund-disabled': 409,
  'ordering.refund-not-allowed': 409,
  'ordering.refund-in-progress': 409,
  'ordering.refund-tax-unknown': 422,
  'ordering.refund-exceeds': 422,
  'ordering.refund-rejected': 422,
  'ordering.refund-tax-unavailable': 503,
  'access.unavailable': 503,
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

const DETAILS = ['fields', 'lineIndexes', 'lines', 'sellers'] as const;

/** The sellers of `ordering.cart-not-ready`: the public minimum leaves as a money body. */
const sellersBody = (sellers: unknown) =>
  (sellers as readonly { sellerId: string; reason: string; minimum: Money | null }[]).map(
    (seller) => ({
      sellerId: seller.sellerId,
      reason: seller.reason,
      minimum: seller.minimum === null ? null : moneyBody(seller.minimum),
    }),
  );

/** Turns a use case's refusal into the HTTP error; an unmapped code is a 500 and is logged. */
export function refusal(
  error: { readonly code: string } & Record<string, unknown>,
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    ORDERING_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'ordering.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  const details = Object.fromEntries(
    DETAILS.filter((key) => error[key] !== undefined).map((key) => [
      key,
      key === 'sellers' ? sellersBody(error[key]) : error[key],
    ]),
  );
  return Object.keys(details).length === 0
    ? fail(status, error.code)
    : fail(status, error.code, details);
}
