import { HttpException } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS, type AccessDenied } from '../../../platform/authz';
import { csrfTokenFor } from '../../../platform/call-context/csrf';
import { sessionCookie } from '../../../platform/call-context/session-cookie';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import type { FieldProblem } from '../application/use-cases/register-customer.use-case';
import type {
  SignInSellerFailure,
  SignInSellerOutput,
  SignInClient,
} from '../application/use-cases/sign-in-seller.use-case';
import { fail, parseStringFields } from './customer-sign-up.controller';
import type { SellerSignedIn } from './seller.dto';

/**
 * The HTTP status of each seller sign-in and confirmation outcome (identity design 5.2, 6.3, as
 * built): the customer's, plus `membership.none` and `seller-access.suspended` as 403 (states
 * told only after full authentication, SEL-04, AC 7).
 */
const SELLER_SIGN_IN_STATUS = {
  'validation.failed': 400,
  'link.rejected': 400,
  'credentials.invalid': 401,
  'email-verification-required': 403,
  'account.disabled': 403,
  'membership.none': 403,
  'seller-access.suspended': 403,
  'request.throttled': 429,
  'request.busy': 503,
  'access.unavailable': 503,
} as const;

const KEEP_SIGNED_IN = 'keepSignedIn';

/** A parsed seller sign-in body: its string fields and the "keep me signed in" choice. */
export interface SellerSignInBody<F extends string> {
  readonly strings: Readonly<Record<F | 'password', string>>;
  readonly keepSignedIn: boolean;
}

/**
 * Checks a closed JSON body of the named string fields plus `password`, and an optional boolean
 * `keepSignedIn` (default false). Values are never echoed (identity design 5.2).
 */
export function parseWithKeepSignedIn<const F extends string>(
  body: unknown,
  fields: readonly F[],
): SellerSignInBody<F> | readonly FieldProblem[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [{ path: '', code: 'type' }];
  }
  const { [KEEP_SIGNED_IN]: keep, ...rest } = body as Record<string, unknown>;
  const problems: FieldProblem[] = [];
  if (keep !== undefined && typeof keep !== 'boolean') {
    problems.push({ path: KEEP_SIGNED_IN, code: 'type' });
  }
  const strings = parseStringFields(rest, [...fields, 'password'] as const);
  if (Array.isArray(strings)) problems.push(...(strings as readonly FieldProblem[]));
  if (problems.length > 0) return problems;
  return {
    strings: strings as Readonly<Record<F | 'password', string>>,
    keepSignedIn: keep === true,
  };
}

/** The outcome code of an answer, for the route's log line. */
export const outcomeOf = (outcome: { code: string } | HttpException): string =>
  outcome instanceof HttpException
    ? (outcome.getResponse() as { code: string }).code
    : outcome.code;

type SellerSignInFailure = SignInSellerFailure | { readonly code: 'link.rejected' } | AccessDenied;

/**
 * The shared answer of seller sign-in and email confirmation (identity design 6.2 to 6.4): the
 * body's shape, the client's origin and address from the resolved client address (ADR-0037; never a forwarded header,
 * Hassan I4), one use case, then the `__Host-session-seller-<MARKET>` cookie on success. The
 * default seller session is a browser-session cookie (no `Max-Age`); "keep me signed in" gives
 * it the absolute lifetime (6.1). The token is never in the body or a log.
 */
export async function answerSellerSignIn<const F extends string>(
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  fields: readonly F[],
  run: (
    input: SellerSignInBody<F> & { readonly client: SignInClient },
  ) => Promise<Result<SignInSellerOutput, SellerSignInFailure>>,
): Promise<SellerSignedIn | HttpException> {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  const input = parseWithKeepSignedIn(body, fields);
  if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
  const origin = clientOriginOf(clientAddressFrom(request));
  const address = clientAddressOf(clientAddressFrom(request));
  if (origin === null || address === null) return fail(503, 'access.unavailable');

  const result = await run({ ...(input as SellerSignInBody<F>), client: { origin, address } });
  if (result.ok) {
    const { token, absoluteLifetimeSeconds, persistent, sellerAccess } = result.value;
    if (sellerAccess === null || sellerAccess === 'suspended') {
      // The flow never opens a seller session without a seller, nor for a suspended one.
      throw new Error('answerSellerSignIn: a seller session without a usable seller state');
    }
    response.setHeader(
      'Set-Cookie',
      sessionCookie(
        'seller',
        context.market.marketId,
        token,
        persistent ? absoluteLifetimeSeconds : null,
      ),
    );
    response.setHeader('Cache-Control', 'no-store');
    return { code: 'signed-in', csrfToken: csrfTokenFor(token), sellerAccess };
  }
  const error = result.error;
  switch (error.code) {
    case 'validation.failed':
      return fail(SELLER_SIGN_IN_STATUS[error.code], error.code, { fields: error.fields });
    case 'request.throttled':
    case 'request.busy':
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
      return fail(SELLER_SIGN_IN_STATUS[error.code], error.code, {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    case 'link.rejected':
    case 'credentials.invalid':
    case 'email-verification-required':
    case 'account.disabled':
    case 'membership.none':
    case 'seller-access.suspended':
    case 'access.unavailable':
      return fail(SELLER_SIGN_IN_STATUS[error.code], error.code);
    case 'access.seller-not-approved':
      return fail(ACCESS_DENIED_STATUS[error.code], error.code, error.details);
    default:
      return fail(ACCESS_DENIED_STATUS[error.code], error.code);
  }
}
