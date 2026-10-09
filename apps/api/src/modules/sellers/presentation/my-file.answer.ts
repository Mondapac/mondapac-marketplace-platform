import { HttpException } from '@nestjs/common';
import type { Result } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import type { FieldProblem } from './my-file.body';

/**
 * The HTTP status of each failure code of the seller's draft use cases (sellers design 6.2, 8.3;
 * the error format of identity design 5.2: `{ statusCode, code, details? }`). Refusals of the
 * gate keep `ACCESS_DENIED_STATUS`. A refusal of a value (`validation.failed`, `phone.required`,
 * `timezone.not-selectable`, `slug.format`, `slug.reserved`, `identifier.format`, `identifier.checksum`) is 400, as identity answers `validation.failed` and
 * `password.rejected`; a state that forbids the request (an incomplete draft, an address outside
 * the areas, a number the register did not match, a submission already pending) is 409.
 */
export const MY_FILE_STATUS = {
  'validation.failed': 400,
  'phone.required': 400,
  'timezone.not-selectable': 400,
  'slug.format': 400,
  'slug.reserved': 400,
  'slug.taken': 409,
  'identifier.format': 400,
  'identifier.checksum': 400,
  'search.too-broad': 400,
  'file.not-found': 404,
  'file.change-request-required': 409,
  'file.incomplete': 409,
  'file.already-submitted': 409,
  'file.nothing-to-withdraw': 409,
  'address.outside-service-area': 409,
  'seller-access.wrong-state': 409,
  'identifier.not-matched': 409,
  'conflict.stale': 409,
  'request.throttled': 429,
  'lookup.limit': 429,
  'sellers.unavailable': 503,
  'access.unavailable': 503,
} as const;

/** An answer in the error format of identity design 5.2. */
export function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

/** Every failure a draft use case or the gate can answer with. */
export type MyFileError =
  | AccessDenied
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'file.incomplete'; readonly missing: readonly string[] }
  | {
      readonly code: 'request.throttled' | 'lookup.limit';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly code: Exclude<
        keyof typeof MY_FILE_STATUS,
        'validation.failed' | 'file.incomplete' | 'request.throttled' | 'lookup.limit'
      >;
    };

/** The response of a failure: codes, field paths and the retry delay only, never a value. */
export function errorOf(error: MyFileError, response: Response): HttpException {
  switch (error.code) {
    case 'validation.failed':
      return fail(MY_FILE_STATUS[error.code], error.code, { fields: error.fields });
    case 'file.incomplete':
      return fail(MY_FILE_STATUS[error.code], error.code, {
        fields: error.missing.map((path) => ({ path, code: 'required' })),
      });
    case 'request.throttled':
    case 'lookup.limit':
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
      return fail(MY_FILE_STATUS[error.code], error.code, {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    case 'access.seller-not-approved':
      return fail(ACCESS_DENIED_STATUS[error.code], error.code, error.details);
    case 'access.unauthenticated':
    case 'access.denied':
      return fail(ACCESS_DENIED_STATUS[error.code], error.code);
    default:
      return fail(MY_FILE_STATUS[error.code], error.code);
  }
}

/** The outcome code of an answer, for the route's log line. */
export const outcomeOf = <T>(result: Result<T, { readonly code: string }>, ok: string): string =>
  result.ok ? ok : result.error.code;
