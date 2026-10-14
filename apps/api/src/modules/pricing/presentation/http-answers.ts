import { HttpException } from '@nestjs/common';
import type { Request } from 'express';

// The parts of a pricing route that every route shares: the error format
// `{ statusCode, code, details? }` and the closed JSON body.

export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** The JSON-only check and the closed object of a body: no unknown key, no array, no scalar. */
export function closedBody(
  request: Request,
  body: unknown,
  keys: readonly string[],
  /** Keys that may be left out; the others are required. */
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
  for (const key of Object.keys(record).sort().slice(0, 10)) {
    if (!keys.includes(key)) {
      fields.push({
        path: Array.from(key).slice(0, 64).join('').replace(/\p{C}/gu, '�'),
        code: 'unknown-field',
      });
    }
  }
  for (const key of keys) {
    if (!optional.includes(key) && !Object.hasOwn(record, key))
      fields.push({ path: key, code: 'required' });
  }
  return fields.length > 0 ? fail(400, 'validation.failed', { fields }) : record;
}
