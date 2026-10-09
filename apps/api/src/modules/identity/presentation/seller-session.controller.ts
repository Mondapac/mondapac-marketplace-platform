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
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { clearedSessionCookie } from '../../../platform/call-context/session-cookie';
import { SessionCsrfToken } from '../../../platform/call-context/session-csrf-token';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import { DescribeSellerStatus } from '../application/use-cases/describe-seller-status.use-case';
import { SignInSeller } from '../application/use-cases/sign-in-seller.use-case';
import { SignOut } from '../application/use-cases/sign-out.use-case';
import { CustomerSignedOut } from './customer-session.dto';
import { fail } from './customer-sign-up.controller';
import { ApiErrorBody } from './customer-sign-up.dto';
import { answerSellerSignIn, outcomeOf } from './seller-sign-in.answer';
import {
  SellerSessionSummary,
  SellerSignedIn,
  SellerSignInRequest,
  SellerStatusBody,
} from './seller.dto';

/**
 * Seller-side sign-in, sign-out, session summary and status over HTTP (identity design 3.3, 6.1
 * to 6.4, 8.6 rows 2 and 9; `ux.md` A1, S1, F2, F4; SEL-04; slice 5). Thin adapters: the
 * `CallContext` comes from `@Call()`, each route calls one use case through its gate and maps
 * the answer to the error format of 5.2.
 *
 * - `POST sign-in` reads no session, so its actor is anonymous; the stricter per-origin limit
 *   applies. On success it sets `__Host-session-seller-<MARKET>`: a browser-session cookie, or
 *   with "keep me signed in" one whose `Max-Age` is the absolute lifetime (6.1).
 * - `POST sign-out`, `GET session` and `GET status` read the seller session cookie of the
 *   request's Market. All three are on the allow-list of 5.2: a seller waiting for approval, or
 *   rejected, may use them (decision 6, AC 4).
 *
 * Every route logs its outcome code with the correlation id; never the email, the name, the
 * password, the token or the address.
 */
@ApiTags('identity')
@RoutePopulation('seller')
@Controller('identity/seller')
export class SellerSessionController {
  readonly #logger = new Logger('SellerSessionController');

  constructor(
    private readonly signInSeller: SignInSeller,
    private readonly signOut: SignOut,
    private readonly describeActor: DescribeActor,
    private readonly describeSellerStatus: DescribeSellerStatus,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Sign in to a seller-side account',
    description:
      'Email, password and the optional "keep me signed in". An unknown address, a wrong ' +
      'password and an account of another type or Market all answer credentials.invalid. ' +
      'After a correct password: email-verification-required, account.disabled, ' +
      'membership.none or seller-access.suspended; otherwise the session cookie is set, and ' +
      'sellerAccess says whether the session is limited (pending, rejected).',
  })
  @ApiBody({ type: SellerSignInRequest })
  @ApiOkResponse({
    type: SellerSignedIn,
    headers: { 'Set-Cookie': { description: 'The seller session cookie' } },
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'credentials.invalid; session.invalid (an Authorization header, HF14)',
  })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description:
      'email-verification-required; account.disabled; membership.none; ' +
      'seller-access.suspended (with details.reason for the Seller Owner only); request.csrf ' +
      '(a refused origin)',
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
  ): Promise<SellerSignedIn> {
    const outcome = await answerSellerSignIn(context, request, response, body, ['email'], (input) =>
      this.signInSeller.execute(context, {
        email: input.strings['email'],
        password: input.strings['password'],
        keepSignedIn: input.keepSignedIn,
        client: input.client,
      }),
    );
    this.log('identity.seller-sign-in', context, outcomeOf(outcome));
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }

  @Post('sign-out')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Sign out of the current seller session',
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
    this.log('identity.seller-sign-out', context, code);
    if (!result.ok) throw this.denied(result.error);
    response.setHeader('Set-Cookie', clearedSessionCookie('seller', context.market.marketId));
    return result.value;
  }

  @Get('session')
  @ReadsSession()
  @ApiOperation({
    summary: 'The signed-in seller-side account and the session',
    description:
      'Ids, the role, the seller access state, the email and name, the session lifetimes and ' +
      'the CSRF token of the session. The answer is not cached.',
  })
  @ApiOkResponse({ type: SellerSessionSummary })
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
  ): Promise<SellerSessionSummary> {
    const result = await this.describeActor.execute(context, {});
    this.log('identity.seller-session', context, result.ok ? 'described' : result.error.code);
    if (!result.ok) throw this.denied(result.error);
    const summary = result.value;
    if (
      csrfToken === null ||
      summary.population !== 'seller' ||
      summary.sellerId === null ||
      summary.displayName === null ||
      summary.sellerAccessState === null
    ) {
      throw fail(ACCESS_DENIED_STATUS['access.denied'], 'access.denied');
    }
    response.setHeader('Cache-Control', 'no-store');
    return {
      ...summary,
      population: 'seller',
      sellerId: summary.sellerId,
      displayName: summary.displayName,
      sellerAccessState: summary.sellerAccessState,
      permissionKeys: [...summary.permissionKeys],
      csrfToken,
    };
  }

  @Get('status')
  @ReadsSession()
  @ApiOperation({
    summary: "The seller's access status (the status page)",
    description:
      'The state, when it last changed, when the account was created and its email confirmed. ' +
      'A seller waiting for approval, or rejected, may read it. The reason of the rejection ' +
      'is returned to the Seller Owner only, with the instant of the latest decision.',
  })
  @ApiOkResponse({ type: SellerStatusBody })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async status(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SellerStatusBody> {
    const result = await this.describeSellerStatus.execute(context, {});
    this.log('identity.seller-status', context, result.ok ? 'described' : result.error.code);
    if (!result.ok) throw this.denied(result.error);
    response.setHeader('Cache-Control', 'no-store');
    return result.value;
  }

  private denied(error: { readonly code: string; readonly details?: object }): HttpException {
    const code = error.code as keyof typeof ACCESS_DENIED_STATUS;
    return fail(ACCESS_DENIED_STATUS[code], code, error.details);
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
