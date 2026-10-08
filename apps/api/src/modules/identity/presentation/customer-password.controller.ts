import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
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
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { SessionPopulation } from '../../../platform/call-context/session-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ChangePassword } from '../application/use-cases/change-password.use-case';
import { RequestPasswordReset } from '../application/use-cases/request-password-reset.use-case';
import { ResetPassword } from '../application/use-cases/reset-password.use-case';
import { ApiErrorBody } from './customer-sign-up.dto';
import {
  answerChangePassword,
  answerPasswordResetEmail,
  answerResetPassword,
} from './password.answer';
import {
  ChangePasswordRequest,
  PasswordChanged,
  PasswordChangedInSession,
  PasswordResetAccepted,
  PasswordResetEmailRequest,
  ResetPasswordRequest,
} from './password.dto';
import { outcomeOf } from './seller-sign-in.answer';

/**
 * Customer password reset and change over HTTP (identity design 3.5, 3.7, 6.5, 6.6; SEL-05,
 * ACC-04; `ux.md` F3, A5, A6, B4; slice 4). Thin adapters: the `CallContext` comes from
 * `@Call()`, each route calls one use case through its gate and maps the answer to the error
 * format of 5.2. JSON only (6.4).
 *
 * - `POST password-reset-email` and `POST reset-password` read no session (their actor is the
 *   Market's anonymous actor) and are under the stricter per-origin limit of anonymous identity
 *   routes.
 * - `POST change-password` reads the customer session cookie of the request's Market and needs
 *   its CSRF token; on success it sets the rotated session's cookie.
 *
 * Every route logs its outcome code with the correlation id; never the email, a password, a
 * token or the address.
 */
@ApiTags('identity')
@Controller('identity/customer')
export class CustomerPasswordController {
  readonly #logger = new Logger('CustomerPasswordController');

  constructor(
    private readonly requestPasswordReset: RequestPasswordReset,
    private readonly resetPassword: ResetPassword,
    private readonly changePassword: ChangePassword,
  ) {}

  @Post('password-reset-email')
  @HttpCode(202)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Ask for a link to reset the password of a customer account',
    description:
      'The answer is the same whether or not the address has a customer account in this Market ' +
      '(AC 21). Only an active account with a confirmed email gets the mail, with a link valid ' +
      'for 60 minutes that replaces any earlier one. Mail is counted per address and per ' +
      'origin; above the limit no mail goes, and the answer is still the same.',
  })
  @ApiBody({ type: PasswordResetEmailRequest })
  @ApiAcceptedResponse({ type: PasswordResetAccepted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid: the request carries an Authorization header (HF14)',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async passwordResetEmail(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<PasswordResetAccepted> {
    const outcome = await answerPasswordResetEmail(
      context,
      request,
      body,
      'customer',
      this.requestPasswordReset,
    );
    return this.settle('identity.customer-password-reset-email', context, outcome);
  }

  @Post('reset-password')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Choose a new password with the mailed reset link',
    description:
      "The token from the link's fragment and the new password. The link works once, for 60 " +
      'minutes. On success every session of the account ends, its sign-in limits are cleared ' +
      'and a notice is mailed; the user then signs in (no session is opened here). A link that ' +
      'is unknown, used, expired, replaced by a newer one, or of another account type or Market ' +
      'answers link.rejected.',
  })
  @ApiBody({ type: ResetPasswordRequest })
  @ApiOkResponse({ type: PasswordChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'validation.failed (details.fields), password.rejected (details.rule) or link.rejected ' +
      '(one answer for every cause)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid: the request carries an Authorization header (HF14)',
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
  async resetPasswordWithLink(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PasswordChanged> {
    const outcome = await answerResetPassword(
      context,
      request,
      response,
      body,
      'customer',
      this.resetPassword,
    );
    return this.settle('identity.customer-reset-password', context, outcome);
  }

  @Post('change-password')
  @HttpCode(200)
  @SessionPopulation('customer')
  // Hassan L4: each change mails a notice, so the route is under the stricter per-origin class.
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Change the password of the signed-in customer',
    description:
      'The current password and the new one. Wrong current passwords are counted as failed ' +
      'sign-ins. On success every other session of the account ends, the current session gets ' +
      'a new token (the cookie is replaced, and the answer carries the new CSRF token) and a ' +
      'notice is mailed.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangePasswordRequest })
  @ApiOkResponse({
    type: PasswordChangedInSession,
    headers: { 'Set-Cookie': { description: 'The session cookie with the new token' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'validation.failed (details.fields), password.rejected (details.rule) or ' +
      'password.current-incorrect',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy (the password-hash queue is full) or access.unavailable',
  })
  async changeOwnPassword(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PasswordChangedInSession> {
    const outcome = await answerChangePassword(
      context,
      request,
      response,
      body,
      'customer',
      this.changePassword,
    );
    return this.settle('identity.customer-change-password', context, outcome);
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T extends { code: string }>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
      outcome: outcomeOf(outcome),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
