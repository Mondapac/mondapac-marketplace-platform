import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
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
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { CompleteSellerSignIn } from '../application/use-cases/complete-seller-sign-in.use-case';
import { ConfirmSellerSecondFactorReset } from '../application/use-cases/confirm-seller-second-factor-reset.use-case';
import { ConfirmSellerSecondFactorEnrolment } from '../application/use-cases/confirm-seller-second-factor-enrolment.use-case';
import { RegenerateSellerRecoveryCodes } from '../application/use-cases/regenerate-seller-recovery-codes.use-case';
import { RemoveSellerSecondFactor } from '../application/use-cases/remove-seller-second-factor.use-case';
import { StartSellerSecondFactorEnrolment } from '../application/use-cases/start-seller-second-factor-enrolment.use-case';
import { adminBody, adminClient, adminFailure } from './admin.answer';
import {
  AdminCodeRequest,
  AdminEnrolmentConfirmRequest,
  AdminEnrolmentStarted,
  RecoveryCodesShown,
} from './admin.dto';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import { codeStepFailure, parseCodeStepBody, signedInAnswer } from './seller-sign-in.answer';
import {
  SellerEnrolmentRequest,
  SellerSecondFactorRemoved,
  SellerSecondFactorResetConfirmRequest,
  SellerSecondFactorResetDone,
  SellerSecondFactorRequest,
  SellerSignedIn,
} from './seller.dto';

/**
 * A seller-side account's own second factor over HTTP (identity design 3.6, 6.3, 7; owner
 * decision 2026-10-08: optional for a seller at launch, compulsory before payouts). The admin's
 * routes are the model; every answer that shows a secret or recovery codes is `no-store`.
 *
 * - `POST sign-in/second-factor` (anonymous: the challenge's token, not a session, binds the
 *   account): the code step after a password step that answered `second-factor-required`; on
 *   success the seller session cookie is set.
 * - `POST second-factor/enrolment` (session + CSRF, the account's password): a new secret and a
 *   challenge token. `POST second-factor/enrolment/confirm` (anonymous like the admin's: the
 *   token binds the account; every session of the account ends and the seller signs in again
 *   with the factor): the first code; the factor is active and the recovery codes are shown once.
 * - `POST second-factor/remove` and `POST second-factor/recovery-codes` (session + CSRF, a code
 *   or a recovery code): switch the factor off; ten new recovery codes shown once.
 *
 * Each route logs its outcome code with the correlation id; never a token, a secret, a code, a
 * password or an address.
 */
@ApiTags('identity')
@RoutePopulation('seller')
@Controller('identity/seller')
export class SellerSecondFactorController {
  readonly #logger = new Logger('SellerSecondFactorController');

  constructor(
    private readonly completeSignIn: CompleteSellerSignIn,
    private readonly startEnrolment: StartSellerSecondFactorEnrolment,
    private readonly confirmEnrolment: ConfirmSellerSecondFactorEnrolment,
    private readonly removeFactor: RemoveSellerSecondFactor,
    private readonly regenerateCodes: RegenerateSellerRecoveryCodes,
    private readonly confirmReset: ConfirmSellerSecondFactorReset,
  ) {}

  @Post('sign-in/second-factor')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "A seller's code step",
    description:
      'The challenge token of the password step, a code from the app or a recovery code, and ' +
      'the optional "keep me signed in". On success the seller session cookie is set. The ' +
      "account's state (disabled, no membership, suspended) is told only after the code.",
  })
  @ApiBody({ type: SellerSecondFactorRequest })
  @ApiOkResponse({
    type: SellerSignedIn,
    headers: { 'Set-Cookie': { description: 'The seller session cookie' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, challenge.rejected or second-factor.invalid',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'account.disabled; membership.none; seller-access.suspended; request.csrf (a refused origin)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'second-factor.locked or request.throttled (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async signInSecondFactor(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerSignedIn> {
    const outcome = await this.codeStep(context, request, response, body);
    return this.settle('identity.seller-second-factor', context, outcome);
  }

  @Post('second-factor/enrolment')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Start enrolling a second factor',
    description:
      "The account's password. Answers a new secret (text and otpauth URI, shown once) and a " +
      'challenge token for the first code. A stale unconfirmed enrolment is replaced; an ' +
      'active factor refuses (remove it first).',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: SellerEnrolmentRequest })
  @ApiOkResponse({ type: AdminEnrolmentStarted })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or password.current-incorrect',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'second-factor.unavailable' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async enrol(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminEnrolmentStarted> {
    const input = adminBody(request, body, ['password'] as const);
    const client = adminClient(request);
    let outcome: AdminEnrolmentStarted | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.startEnrolment.execute(context, { ...input, client });
      outcome = result.ok
        ? this.noStore(response, { ...result.value, expiresAt: result.value.expiresAt.toString() })
        : adminFailure(response, result.error);
    }
    return this.settle('identity.seller-enrolment', context, outcome);
  }

  @Post('second-factor/enrolment/confirm')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Confirm an enrolment with the first code',
    description:
      'The challenge token and the first code from the app. The factor becomes active, every ' +
      'session of the account ends, and ten recovery codes are shown once.',
  })
  @ApiBody({ type: AdminEnrolmentConfirmRequest })
  @ApiOkResponse({ type: RecoveryCodesShown })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, challenge.rejected or second-factor.invalid',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'second-factor.locked or request.throttled (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async confirm(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RecoveryCodesShown> {
    const input = adminBody(request, body, ['challengeToken', 'code'] as const);
    const client = adminClient(request);
    let outcome: RecoveryCodesShown | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.confirmEnrolment.execute(context, { ...input, client });
      outcome = result.ok
        ? this.noStore(response, {
            ...result.value,
            recoveryCodes: [...result.value.recoveryCodes],
          })
        : adminFailure(response, result.error);
    }
    return this.settle('identity.seller-enrolment-confirm', context, outcome);
  }

  @Post('second-factor/reset/confirm')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Confirm a second-factor reset that an admin started (A11)',
    description:
      "The token from the fragment of E15's link, valid 24 hours and once. Anonymous: the link " +
      "is bound to the Seller Owner's account. The factor and its recovery codes are removed, " +
      'every session of the account ends and a notice is mailed; no session is opened. A link ' +
      'that is unknown, used, expired, replaced by a newer one, or of an account that is no ' +
      'longer the Seller Owner answers link.rejected.',
  })
  @ApiBody({ type: SellerSecondFactorResetConfirmRequest })
  @ApiOkResponse({ type: SellerSecondFactorResetDone })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields) or link.rejected (one answer for every cause)',
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
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async confirmSecondFactorReset(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerSecondFactorResetDone> {
    const input = adminBody(request, body, ['token'] as const);
    const client = adminClient(request);
    let outcome: SellerSecondFactorResetDone | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.confirmReset.execute(context, { token: input.token, client });
      outcome = result.ok
        ? this.noStore(response, result.value)
        : adminFailure(response, result.error);
    }
    return this.settle('identity.seller-second-factor-reset-confirm', context, outcome);
  }

  @Post('second-factor/remove')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Switch the second factor off',
    description:
      'A code from the app, or a recovery code. The factor and its recovery codes are removed, ' +
      'every other session of the account ends and a notice is mailed; this session continues.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminCodeRequest })
  @ApiOkResponse({ type: SellerSecondFactorRemoved })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'second-factor.unavailable' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async remove(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<SellerSecondFactorRemoved> {
    const input = adminBody(request, body, ['code'] as const);
    let outcome: SellerSecondFactorRemoved | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.removeFactor.execute(context, input);
      outcome = result.ok
        ? this.noStore(response, result.value)
        : adminFailure(response, result.error);
    }
    return this.settle('identity.seller-second-factor-remove', context, outcome);
  }

  @Post('second-factor/recovery-codes')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Make ten new recovery codes',
    description:
      'A code from the app, or a recovery code. Every earlier recovery code stops working; ' +
      'the new ones are shown once.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminCodeRequest })
  @ApiOkResponse({ type: RecoveryCodesShown })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'second-factor.unavailable' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async recoveryCodes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RecoveryCodesShown> {
    const input = adminBody(request, body, ['code'] as const);
    let outcome: RecoveryCodesShown | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.regenerateCodes.execute(context, input);
      outcome = result.ok
        ? this.noStore(response, {
            ...result.value,
            recoveryCodes: [...result.value.recoveryCodes],
          })
        : adminFailure(response, result.error);
    }
    return this.settle('identity.seller-recovery-codes', context, outcome);
  }

  private async codeStep(
    context: CallContext,
    request: Request,
    response: Response,
    body: unknown,
  ): Promise<SellerSignedIn | HttpException> {
    if (request.is('application/json') !== 'application/json') {
      return fail(415, 'request.body-unsupported');
    }
    const input = parseCodeStepBody(body);
    if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
    const resolved = clientAddressFrom(request);
    const origin = clientOriginOf(resolved);
    const address = clientAddressOf(resolved);
    if (origin === null || address === null) return fail(503, 'access.unavailable');
    const typed = input as Exclude<typeof input, readonly unknown[]>;
    const result = await this.completeSignIn.execute(context, {
      ...typed,
      client: { origin, address },
    });
    return result.ok
      ? signedInAnswer(context, response, result.value)
      : codeStepFailure(response, result.error);
  }

  private noStore<T>(response: Response, value: T): T {
    response.setHeader('Cache-Control', 'no-store');
    return value;
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T extends { code: string }>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
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
}
