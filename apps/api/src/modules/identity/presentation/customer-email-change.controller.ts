import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
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
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ConfirmCustomerEmailChange } from '../application/use-cases/confirm-customer-email-change.use-case';
import {
  CustomerConfirmEmailChangeRequest,
  CustomerEmailChangeConfirmed,
} from './customer-email-verification.dto';
import { fail, parseStringFields } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';

/** The HTTP status of each answer (Hassan R7: only these codes, besides a malformed body). */
const CONFIRM_STATUS = {
  'validation.failed': 400,
  'link.rejected': 400,
  'credentials.invalid': 401,
  'request.throttled': 429,
  'request.busy': 503,
  'access.unavailable': 503,
} as const;

/**
 * The customer's confirmation of a sign-in email an admin changed (customers admin email change;
 * Hassan R1, R7, R8). An anonymous identity route: the stricter per-origin limit applies, JSON
 * only, no session is read and none is set. The storefront page that posts here reads the token
 * from its URL fragment and sends it in the body. Every answer is `Cache-Control: no-store` and
 * `Referrer-Policy: no-referrer`. The outcome code is logged with the correlation id; never the
 * token, the password or an address.
 */
@ApiTags('identity')
@RateLimit('anonymous-identity')
@RoutePopulation('customer')
@Controller('identity/customer')
export class CustomerEmailChangeController {
  readonly #logger = new Logger('CustomerEmailChangeController');

  constructor(private readonly confirmEmailChange: ConfirmCustomerEmailChange) {}

  @Post('email-change/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm a new sign-in email with the mailed link and the password',
    description:
      "The token from the fragment of the link mailed to the new address, and the account's " +
      'password. A correct password swaps the sign-in email, uses the link up, ends every session ' +
      'of the account and stops its other links; no session is opened. A link that is unknown, ' +
      'used, expired, replaced, cancelled, of another purpose or Market, or whose address another ' +
      'account took meanwhile answers link.rejected. Throttled and counted like sign-in.',
  })
  @ApiBody({ type: CustomerConfirmEmailChangeRequest })
  @ApiOkResponse({ type: CustomerEmailChangeConfirmed })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or link.rejected (one answer for every cause)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'credentials.invalid; session.invalid (an Authorization header, HF14)',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy (the password-hash queue is full) or access.unavailable',
  })
  async confirm(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CustomerEmailChangeConfirmed> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const outcome = await this.answer(context, request, response, body);
    this.#logger.log({
      msg: 'identity.customer-confirm-email-change',
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : outcome.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  private async answer(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<CustomerEmailChangeConfirmed | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseStringFields(body, ['token', 'password'] as const);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    // The resolved client address (ADR-0037): forwarded headers are never trusted.
    const origin = clientOriginOf(clientAddressFrom(request));
    const address = clientAddressOf(clientAddressFrom(request));
    if (origin === null || address === null) return fail(503, 'access.unavailable');
    const fields = input as Readonly<Record<'token' | 'password', string>>;
    const result = await this.confirmEmailChange.execute(context, {
      token: fields.token,
      password: fields.password,
      client: { origin, address },
    });
    if (result.ok) return { code: result.value.code };
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
      case 'access.unavailable':
        return fail(CONFIRM_STATUS[error.code], error.code);
      case 'access.seller-not-approved':
        return fail(ACCESS_DENIED_STATUS[error.code], error.code, error.details);
      default:
        return fail(ACCESS_DENIED_STATUS[error.code], error.code);
    }
  }
}
