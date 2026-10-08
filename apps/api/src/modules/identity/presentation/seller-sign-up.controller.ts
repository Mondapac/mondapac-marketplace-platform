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
import { clientOriginOf } from '../../../platform/rate-limit/client-origin';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ConfirmSellerEmail } from '../application/use-cases/confirm-seller-email.use-case';
import { RegisterSeller } from '../application/use-cases/register-seller.use-case';
import { RequestSellerVerification } from '../application/use-cases/request-seller-verification.use-case';
import {
  CustomerVerificationEmailAccepted,
  CustomerVerificationEmailRequest,
} from './customer-email-verification.dto';
import { fail, parseStringFields } from './customer-sign-up.controller';
import { ApiErrorBody, CustomerSignUpAccepted } from './customer-sign-up.dto';
import { answerSellerSignIn, outcomeOf } from './seller-sign-in.answer';
import { SellerConfirmEmailRequest, SellerSignedIn, SellerSignUpRequest } from './seller.dto';

/**
 * Seller self-registration and email verification over HTTP (identity design 3.1, 3.2, 6.7, 8.6
 * rows 1 and 3; `ux.md` A2 to A4, F4 steps 1 to 3; SEL-01; slice 5). Thin adapters: the
 * `CallContext` comes from `@Call()`, each route calls one use case through its gate and maps
 * the answer to the error format of 5.2. Anonymous identity routes: the stricter per-origin
 * limit applies, JSON only (6.4), no session is read.
 *
 * - `POST sign-up`: name, email and password; one answer for every address (AC 21).
 * - `POST confirm-email`: the link's token and the password; on success the email is confirmed
 *   and the seller session cookie set, as at sign-in.
 * - `POST verification-email`: "send it again"; one answer for every address.
 *
 * Every route logs its outcome code with the correlation id; never the name, the email, the
 * password or the link token.
 */
@ApiTags('identity')
@RateLimit('anonymous-identity')
@Controller('identity/seller')
export class SellerSignUpController {
  readonly #logger = new Logger('SellerSignUpController');

  constructor(
    private readonly registerSeller: RegisterSeller,
    private readonly confirmSellerEmail: ConfirmSellerEmail,
    private readonly requestVerification: RequestSellerVerification,
  ) {}

  @Post('sign-up')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Create a seller account (self-registration)',
    description:
      'Name, email and password. Creates the seller and its owner account, unverified; the ' +
      'owner confirms the email through the mailed link. The answer is the same whether or not ' +
      'the address already has a seller-side account in this Market (AC 21); only the mail ' +
      'differs. access.unavailable when this Market offers no seller sign-up or its roles are ' +
      'not seeded yet.',
  })
  @ApiBody({ type: SellerSignUpRequest })
  @ApiAcceptedResponse({ type: CustomerSignUpAccepted })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or password.rejected (details.rule)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid: the request carries an Authorization header (HF14)',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy (the password-hash queue is full) or access.unavailable',
  })
  async signUp(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CustomerSignUpAccepted> {
    const outcome = await this.answerSignUp(context, request, response, body);
    this.log('identity.seller-sign-up', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post('confirm-email')
  @HttpCode(200)
  @ApiOperation({
    summary: "Confirm a seller-side account's email with the mailed link and the password",
    description:
      "The token from the link's fragment and the account's password. A correct password " +
      'confirms the email, uses the link up and signs in (the seller session cookie is set): ' +
      'a seller waiting for approval gets a limited session. A link that is unknown, used, ' +
      'expired, replaced by a newer one, or of another account type or Market answers ' +
      'link.rejected. Throttled like sign-in.',
  })
  @ApiBody({ type: SellerConfirmEmailRequest })
  @ApiOkResponse({
    type: SellerSignedIn,
    headers: { 'Set-Cookie': { description: 'The seller session cookie' } },
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
    description:
      'account.disabled, membership.none or seller-access.suspended (the link stays unused); ' +
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
  async confirmEmail(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerSignedIn> {
    const outcome = await answerSellerSignIn(context, request, response, body, ['token'], (input) =>
      this.confirmSellerEmail.execute(context, {
        token: input.strings['token'],
        password: input.strings['password'],
        keepSignedIn: input.keepSignedIn,
        client: input.client,
      }),
    );
    this.log('identity.seller-confirm-email', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post('verification-email')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send the seller verification email again',
    description:
      'The answer is the same whether or not the address has an unverified seller-side account ' +
      'in this Market (AC 21). A new link replaces the earlier one. Mail is counted per address ' +
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
    this.log('identity.seller-verification-email', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  private async answerSignUp(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<CustomerSignUpAccepted | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseStringFields(body, ['displayName', 'email', 'password'] as const);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    // The origin of the mail counter, from the socket only (never a forwarded header, HF3).
    const origin = clientOriginOf(request.socket.remoteAddress);
    if (origin === null) return fail(503, 'access.unavailable');

    const fields = input as Readonly<Record<'displayName' | 'email' | 'password', string>>;
    const result = await this.registerSeller.execute(context, { ...fields, origin });
    if (result.ok) return result.value;
    const error = result.error;
    switch (error.code) {
      case 'validation.failed':
        return fail(400, error.code, { fields: error.fields });
      case 'password.rejected':
        return fail(400, error.code, { rule: error.rule });
      case 'request.busy':
        response.setHeader('Retry-After', String(error.retryAfterSeconds));
        return fail(503, error.code, { retryAfterSeconds: error.retryAfterSeconds });
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
    const origin = clientOriginOf(request.socket.remoteAddress);
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
