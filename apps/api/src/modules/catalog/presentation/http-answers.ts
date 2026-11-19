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
const DETAIL_KEYS = [
  'fields',
  'issues',
  'retryAfterSeconds',
  'max',
  'tags',
  'brands',
  'total',
  'unit',
  'currentCount',
  'columns',
  'maxBytes',
  'rows',
  'detected',
  'rowNumber',
  'typeCodes',
  'errors',
  'leftOut',
  'resetZone',
  'pendingNumber',
] as const;

/**
 * Refusals every catalog route shares: an action that waits for approval (Admin Inbox › System
 * requests) while another proposal of the same subject waits (`details.pendingNumber`).
 */
const SHARED_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'system-requests.already-pending': 409,
});

/**
 * The body of a use case's answer, and HTTP 202 when it is a proposal: an action that waits for a
 * second admin's approval answers `{request: {id, number}}` and wrote nothing.
 */
export function answered<T>(response: Response, value: unknown): T {
  if (onlyRequest(value)) response.status(202);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Whether a use case answered a proposal: an object holding only a non-null `request` (an action
 * that waits for another admin's approval; nothing changed). The presentation layer reads it from
 * the answer's shape, as it imports only use cases.
 */
function onlyRequest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  const request = (value as { request?: unknown }).request;
  return (
    keys.length === 1 && keys[0] === 'request' && typeof request === 'object' && request !== null
  );
}

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
    table[error.code] ??
    SHARED_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
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

/**
 * The query of a page-numbered list route: `page` and `pageSize` become numbers (a value that is
 * not 1 to 4 digits becomes -1, which the list refuses).
 */
export function numericQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const key of ['page', 'pageSize']) {
    const value = out[key];
    if (value !== undefined) {
      out[key] = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : -1;
    }
  }
  return out;
}

/** The JSON-only check and the closed object of a body: no unknown key, no array, no scalar. */
export function closedBody(
  request: Request,
  body: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed', { fields: [{ path: '', code: 'type' }] });
  }
  const record = body as Record<string, unknown>;
  const fields: { path: string; code: string }[] = [];
  for (const key of Object.keys(record).sort()) {
    if (fields.length >= 10) break;
    if (!keys.includes(key) && !optional.includes(key)) {
      fields.push({
        path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '\uFFFD'),
        code: 'unknown-field',
      });
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) fields.push({ path: key, code: 'required' });
  }
  return fields.length > 0 ? fail(400, 'validation.failed', { fields }) : record;
}

/**
 * A body that may be absent: no body at all is `{}`; a body present must be JSON and closed to
 * the optional keys (unknown keys refused, not ignored).
 */
export function optionalClosedBody(
  request: Request,
  body: unknown,
  optional: readonly string[],
): Record<string, unknown> | HttpException {
  const empty =
    body === undefined ||
    (typeof body === 'object' && body !== null && Object.keys(body).length === 0);
  if (empty && request.is('application/json') !== 'application/json') return {};
  return closedBody(request, body, [], optional);
}
