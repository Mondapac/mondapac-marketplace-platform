import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { csrfTokenFor, CSRF_HEADER } from '../../../platform/call-context/csrf';
import { clearedSessionCookie, sessionCookie } from '../../../platform/call-context/session-cookie';
import { SessionCsrfToken } from '../../../platform/call-context/session-csrf-token';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import { SignInCustomer } from '../application/use-cases/sign-in-customer.use-case';
import { SignOut } from '../application/use-cases/sign-out.use-case';
import { fail, parseSignUpBody } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import {
  CustomerSessionSummary,
  CustomerSignedIn,
  CustomerSignedOut,
  CustomerSignInRequest,
} from './customer-session.dto';

/**
 * The HTTP status of each sign-in outcome (identity design 5.2 and 6.3). The design names the
 * codes; these statuses are this slice's choice, recorded in identity design 6.3 (as built).
 */
const SIGN_IN_STATUS = {
  'validation.failed': 400,
  'credentials.invalid': 401,
  'email-verification-required': 403,
  'account.disabled': 403,
  'request.throttled': 429,
  'request.busy': 503,
  'access.unavailable': 503,
} as const;

const outcomeOf = (outcome: { code: string } | HttpException): string =>
  outcome instanceof HttpException
    ? (outcome.getResponse() as { code: string }).code
    : outcome.code;

/**
 * Customer sign-in, sign-out and session summary over HTTP (identity design 6.2 to 6.4, 8.6;
 * slice 2). Thin adapters: the `CallContext` comes from `@Call()`, each route calls one use case
 * through its gate and maps the answer to the error format of 5.2.
 *
 * - `POST sign-in` reads no session (no `@ReadsSession`), so its actor is anonymous; the
 *   stricter per-origin limit applies. On success it sets the `__Host-` session cookie with the
 *   absolute lifetime as `Max-Age`; the token is never in the body.
 * - `POST sign-out` and `GET session` read the customer session cookie of the request's Market.
 *
 * Every route logs its outcome code with the correlation id; never the email, the password,
 * the token or the address.
 */
@ApiTags('identity')
@RoutePopulation('customer')
@Controller('identity/customer')
export class CustomerSessionController {
  readonly #logger = new Logger('CustomerSessionController');

  constructor(
    private readonly signInCustomer: SignInCustomer,
    private readonly signOut: SignOut,
    private readonly describeActor: DescribeActor,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Sign in to a customer account',
    description:
      'Email and password. An unknown address, a wrong password and an account of another ' +
      'type or Market all answer credentials.invalid. Failed attempts are counted per address ' +
      'and origin, per address and per origin; above a limit the answer is request.throttled ' +
      'with the wait. On success the session cookie is set.',
  })
  @ApiBody({ type: CustomerSignInRequest })
  @ApiOkResponse({
    type: CustomerSignedIn,
    headers: { 'Set-Cookie': { description: 'The session cookie' } },
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'credentials.invalid; session.invalid (an Authorization header, HF14)',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'email-verification-required (sign in through the verification link); account.disabled; ' +
      'request.csrf (a refused origin)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy (the password-hash queue is full) or access.unavailable',
  })
  async signIn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CustomerSignedIn> {
    const outcome = await this.answerSignIn(context, request, response, body);
    this.log('identity.customer-sign-in', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post('sign-out')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Sign out of the current customer session',
    description: 'Revokes the session of the cookie and clears the cookie.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiOkResponse({ type: CustomerSignedOut })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async signOutOfSession(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerSignedOut> {
    const result = await this.signOut.execute(context, {});
    const code = result.ok ? result.value.code : result.error.code;
    this.log('identity.customer-sign-out', context, code);
    if (!result.ok) throw fail(ACCESS_DENIED_STATUS[result.error.code], result.error.code);
    response.setHeader('Set-Cookie', clearedSessionCookie('customer', context.market.marketId));
    return result.value;
  }

  @Get('session')
  @ReadsSession()
  @ApiOperation({
    summary: 'The signed-in customer and the session',
    description:
      'Ids, the email, the session lifetimes and the CSRF token of the session. The answer is ' +
      'not cached.',
  })
  @ApiOkResponse({ type: CustomerSessionSummary })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async session(
    @Call() context: CallContext,
    @SessionCsrfToken() csrfToken: string | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerSessionSummary> {
    const result = await this.describeActor.execute(context, {});
    const code = result.ok ? 'described' : result.error.code;
    this.log('identity.customer-session', context, code);
    if (!result.ok) {
      throw fail(ACCESS_DENIED_STATUS[result.error.code], result.error.code);
    }
    if (csrfToken === null || result.value.population !== 'customer') {
      throw fail(ACCESS_DENIED_STATUS['access.denied'], 'access.denied');
    }
    response.setHeader('Cache-Control', 'no-store');
    return {
      ...result.value,
      population: 'customer',
      permissionKeys: [...result.value.permissionKeys],
      csrfToken,
    };
  }

  private async answerSignIn(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<CustomerSignedIn | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseSignUpBody(body);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    // The resolved client address (ADR-0037): forwarded headers are never trusted (Hassan I4).
    const origin = clientOriginOf(clientAddressFrom(request));
    const address = clientAddressOf(clientAddressFrom(request));
    if (origin === null || address === null) return fail(503, 'access.unavailable');

    const fields = input as { email: string; password: string };
    const result = await this.signInCustomer.execute(context, {
      email: fields.email,
      password: fields.password,
      client: { origin, address },
    });
    if (result.ok) {
      const { token, absoluteLifetimeSeconds } = result.value;
      response.setHeader(
        'Set-Cookie',
        sessionCookie('customer', context.market.marketId, token, absoluteLifetimeSeconds),
      );
      response.setHeader('Cache-Control', 'no-store');
      return { code: 'signed-in', csrfToken: csrfTokenFor(token) };
    }
    const error = result.error;
    switch (error.code) {
      case 'validation.failed':
        return fail(SIGN_IN_STATUS[error.code], error.code, { fields: error.fields });
      case 'request.throttled':
      case 'request.busy':
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return fail(SIGN_IN_STATUS[error.code], error.code, {
          retryAfterSeconds: error.retryAfterSeconds,
        });
      case 'credentials.invalid':
      case 'email-verification-required':
      case 'account.disabled':
      case 'access.unavailable':
        return fail(SIGN_IN_STATUS[error.code], error.code);
      case 'access.seller-not-approved':
        return fail(ACCESS_DENIED_STATUS[error.code], error.code, error.details);
      default:
        return fail(ACCESS_DENIED_STATUS[error.code], error.code);
    }
  }

  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
