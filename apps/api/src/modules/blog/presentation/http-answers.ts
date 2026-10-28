import { HttpException, type Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of a blog route that every route shares: the error format `{ statusCode, code,
// details? }`, the closed JSON body, the status of each refusal and the JSON form of a view.

export const BLOG_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'blog.post-not-found': 404,
  'blog.not-found': 404,
  'blog.category-not-found': 404,
  'blog.tag-not-found': 404,
  'blog.gone': 410,
  'blog.access-off': 403,
  'blog.seller-owned': 403,
  'blog.self-approval-refused': 403,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  'blog.post-archived': 409,
  'blog.wrong-state': 409,
  'blog.slug-taken': 409,
  'blog.category-slug-taken': 409,
  'blog.category-in-use': 409,
  'blog.tag-slug-taken': 409,
  'blog.tag-in-use': 409,
  'blog.quota-used': 409,
  'blog.version-limit': 409,
  'conflict.stale': 409,
  'blog.checks-failed': 422,
  'blog.unavailable': 503,
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

/** Turns a use case's refusal into the HTTP error; an unmapped code is a 500 and is logged. */
export function refusal(
  error: { readonly code: string } & Record<string, unknown>,
  context: CallContext,
  logger: Logger,
): HttpException {
  const status =
    BLOG_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'blog.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (error.findings !== undefined) return fail(status, error.code, { findings: error.findings });
  if (error.actionKey !== undefined)
    return fail(status, error.code, { actionKey: error.actionKey });
  if (typeof error.details === 'object' && error.details !== null) {
    return fail(status, error.code, error.details);
  }
  return fail(status, error.code);
}

/** A view as JSON: every instant becomes its ISO string, every other value stays as it is. */
export function plain(value: unknown): unknown {
  if (value instanceof Temporal.Instant) return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}
