import { HttpException, type Logger } from '@nestjs/common';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request } from 'express';
import { conflictDetails } from '../../../platform/audit/change-trail';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';

// The parts of an assistant route that every route shares: the error format
// `{ statusCode, code, details? }`, the closed JSON body and the status of each refusal.

export const ASSISTANT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'assistant.off': 403,
  'assistant.sign-in-required': 403,
  'assistant.conversation-not-found': 404,
  'assistant.conflict': 409,
  'assistant.conversation-full': 409,
  'request.throttled': 429,
  'assistant.paused': 503,
  'assistant.unavailable': 503,
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
    ASSISTANT_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS];
  if (status === undefined) {
    logger.error({
      msg: 'assistant.unmapped-refusal',
      code: error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return fail(500, 'internal');
  }
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (error.retryAfterSeconds !== undefined) {
    return fail(status, error.code, { retryAfterSeconds: error.retryAfterSeconds });
  }
  const conflict = conflictDetails(error);
  if (conflict !== undefined) return fail(status, error.code, conflict);
  return fail(status, error.code);
}
