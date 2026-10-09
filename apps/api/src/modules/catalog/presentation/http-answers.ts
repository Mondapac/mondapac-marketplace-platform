import { HttpException, Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of a catalog route that every route shares: the error format
// `{ statusCode, code, details? }`, the refusal-to-status mapping, and the closed JSON body.

export type Refusal = { readonly code: string; readonly retryAfterSeconds?: number };

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** The refusal fields that reach the client as `details`; any other field stays on the server. */
const DETAIL_KEYS = ['fields', 'issues', 'retryAfterSeconds', 'max'] as const;
const logger = new Logger('CatalogHttp');

/**
 * A refusal as an error answer: its status, the allow-listed detail fields, and `Retry-After`
 * with a wait. A code with no status is a defect: it answers a bare `internal` and the code is
 * logged, never sent.
 */
export function refusalWith(
  table: Readonly<Record<string, number>>,
  error: Refusal,
  response: Response,
  context?: CallContext,
  unmappedMsg = 'catalog.unmapped-refusal',
): HttpException {
  const status =
    table[error.code] ?? ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: unmappedMsg,
      code: error.code,
      marketId: context?.market.marketId,
      correlationId: context?.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  const details = Object.fromEntries(
    DETAIL_KEYS.filter((key) => key in error).map((key) => [
      key,
      (error as Record<string, unknown>)[key],
    ]),
  );
  return Object.keys(details).length === 0
    ? fail(status, error.code)
    : fail(status, error.code, details);
}

/** The page request of a list route from its query string: `afterId` and a numeric `limit`. */
export function pageQuery(query: Record<string, unknown>): Record<string, unknown> {
  const { limit, ...rest } = query;
  if (limit === undefined) return rest;
  return {
    ...rest,
    limit: typeof limit === 'string' && /^\d{1,4}$/.test(limit) ? Number(limit) : -1,
  };
}

/** The JSON-only check and the closed object of a body: no unknown key, no array, no scalar. */
export function closedBody(
  request: Request,
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed', { fields: [{ path: '', code: 'type' }] });
  }
  const record = body as Record<string, unknown>;
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(record).sort().slice(0, 10)) {
    if (!keys.includes(key)) {
      fields.push({
        path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
        code: 'unknown-field',
      });
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fields.push({ path: key, code: 'required' });
  }
  return fields.length > 0 ? fail(400, 'validation.failed', { fields }) : record;
}
