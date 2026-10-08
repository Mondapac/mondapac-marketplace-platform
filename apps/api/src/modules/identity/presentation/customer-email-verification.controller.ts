import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { csrfTokenFor } from '../../../platform/call-context/csrf';
import { sessionCookie } from '../../../platform/call-context/session-cookie';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ConfirmCustomerEmail } from '../application/use-cases/confirm-customer-email.use-case';
import { RequestCustomerVerification } from '../application/use-cases/request-customer-verification.use-case';
import {
  CustomerConfirmEmailRequest,
  CustomerVerificationEmailAccepted,
  CustomerVerificationEmailRequest,
} from './customer-email-verification.dto';
import { CustomerSignedIn } from './customer-session.dto';
import { fail, parseStringFields } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';

/**
 * The HTTP status of each confirmation outcome. The design names the codes (8.6 row 1); the
 * statuses follow sign-in's (identity design 6.3, as built) and add `link.rejected` as 400.
 */
const CONFIRM_STATUS = {
  'validation.failed': 400,
  'link.rejected': 400,
  'credentials.invalid': 401,
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
 * Customer email verification over HTTP (identity design 3.2, 6.6, 6.7, 8.6 rows 1 and 3; `ux.md`
 * A3 and A4; slice 3). Thin adapters: the `CallContext` comes from `@Call()`, each route calls one
 * use case through its gate and maps the answer to the error format of 5.2. Anonymous identity
 * routes: the stricter per-origin limit applies, JSON only (6.4), no session is read.
 *
 * - `POST confirm-email`: the link's token and the password. On success the email is confirmed
 *   and the session cookie set, as at sign-in; the token is never in the body.
 * - `POST verification-email`: "send it again"; one answer for every address.
 *
 * Every route logs its outcome code with the correlation id; never the email, the password or
 * the link token.
 */
@ApiTags('identity')
@RateLimit('anonymous-identity')
@Controller('identity/customer')
export class CustomerEmailVerificationController {
  readonly #logger = new Logger('CustomerEmailVerificationController');

  constructor(
    private readonly confirmCustomerEmail: ConfirmCustomerEmail,
    private readonly requestVerification: RequestCustomerVerification,
  ) {}

  @Post('confirm-email')
  @HttpCode(200)
  @ApiOperation({
    summary: "Confirm a customer's email with the mailed link and the password",
    description:
      "The token from the link's fragment and the account's password. A correct password " +
      'confirms the email, uses the link up and signs in (the session cookie is set). A link ' +
      'that is unknown, used, expired, replaced by a newer one, or of another account type or ' +
      'Market answers link.rejected. Throttled like sign-in.',
  })
  @ApiBody({ type: CustomerConfirmEmailRequest })
  @ApiOkResponse({
    type: CustomerSignedIn,
    headers: { 'Set-Cookie': { description: 'The session cookie' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or link.rejected (one answer for every cause)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'credentials.invalid; session.invalid (an Authorization header, HF14)',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'account.disabled (the link stays unused); request.csrf (a refused origin)',
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
  async confirmEmail(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CustomerSignedIn> {
    const outcome = await this.answerConfirm(context, request, response, body);
    this.log('identity.customer-confirm-email', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post('verification-email')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send the verification email again',
    description:
      'The answer is the same whether or not the address has an unverified customer account in ' +
      'this Market (AC 21). A new link replaces the earlier one. Mail is counted per address ' +
      'and per origin; above the limit no mail goes, and the answer is still the same.',
  })
  @ApiBody({ type: CustomerVerificationEmailRequest })
  @ApiAcceptedResponse({ type: CustomerVerificationEmailAccepted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid: the request carries an Authorization header (HF14)',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async verificationEmail(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<CustomerVerificationEmailAccepted> {
    const outcome = await this.answerResend(context, request, body);
    this.log('identity.customer-verification-email', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  private async answerConfirm(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<CustomerSignedIn | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseStringFields(body, ['token', 'password'] as const);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    // The resolved client address (ADR-0037): forwarded headers are never trusted (Hassan I4).
    const origin = clientOriginOf(clientAddressFrom(request));
    const address = clientAddressOf(clientAddressFrom(request));
    if (origin === null || address === null) return fail(503, 'access.unavailable');

    const fields = input as Readonly<Record<'token' | 'password', string>>;
    const result = await this.confirmCustomerEmail.execute(context, {
      token: fields.token,
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
        return fail(CONFIRM_STATUS[error.code], error.code, { fields: error.fields });
      case 'request.throttled':
      case 'request.busy':
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return fail(CONFIRM_STATUS[error.code], error.code, {
          retryAfterSeconds: error.retryAfterSeconds,
        });
      case 'link.rejected':
      case 'credentials.invalid':
      case 'account.disabled':
      case 'access.unavailable':
        return fail(CONFIRM_STATUS[error.code], error.code);
      case 'access.seller-not-approved':
        return fail(ACCESS_DENIED_STATUS[error.code], error.code, error.details);
      default:
        return fail(ACCESS_DENIED_STATUS[error.code], error.code);
    }
  }

  private async answerResend(
    context: CallContext,
    request: Request,
    body: unknown,
  ): Promise<CustomerVerificationEmailAccepted | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseStringFields(body, ['email'] as const);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    const origin = clientOriginOf(clientAddressFrom(request));
    if (origin === null) return fail(503, 'access.unavailable');

    const result = await this.requestVerification.execute(context, {
      email: (input as Readonly<Record<'email', string>>).email,
      origin,
    });
    if (result.ok) return result.value;
    const error = result.error;
    switch (error.code) {
      case 'validation.failed':
        return fail(400, error.code, { fields: error.fields });
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
