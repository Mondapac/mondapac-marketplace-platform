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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { ConnectPayoutAccount } from '../application/use-cases/connect-payout-account.use-case';
import { OpenPayoutAccountLink } from '../application/use-cases/open-payout-account-link.use-case';
import { ViewPayoutAccount } from '../application/use-cases/view-payout-account.use-case';
import {
  PayoutAccountBody,
  PayoutAccountCodeRequest,
  PayoutAccountLinkBody,
  payoutAccountBody,
  payoutAccountLinkBody,
} from './payout-account.dto';

/** The HTTP status of each refusal of the payout-account routes. */
export const PAYOUT_ACCOUNT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'payments.payout-account.not-found': 404,
  'payments.payout-account.rejected': 409,
  'payments.payout-account.second-factor-required': 403,
  'payments.unavailable': 503,
  'second-factor.invalid': 400,
  'second-factor.locked': 429,
  ...ACCESS_DENIED_STATUS,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

const fail = (status: number, code: string, details?: object): HttpException =>
  new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);

/**
 * The JSON-only check and the closed `{ code }` body of the two write routes. A missing or
 * non-string code is not an error here: the use case answers it `second-factor.invalid` after
 * it has checked that the seller has two-step sign-in on.
 */
function codeOf(request: Request, body: unknown): { code?: unknown } | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(400, 'validation.failed');
  }
  if (Object.keys(body).some((key) => key !== 'code')) return fail(400, 'validation.failed');
  return { code: (body as { code?: unknown }).code };
}

/**
 * The seller's payout account (Stripe Connect Express, test mode): `GET` its state, `POST` to
 * create it and get the hosted onboarding page, `POST .../link` for a fresh page. Thin adapters:
 * the seller comes from the session, never from the request, and each use case does its work
 * through its gate. The return pages Stripe sends the seller back to come from Market config.
 * Every answer is `Cache-Control: no-store`.
 */
@ApiTags('payments')
@RoutePopulation('seller')
@Controller('payments/seller/payout-account')
export class SellerPayoutAccountController {
  readonly #logger = new Logger('SellerPayoutAccountController');

  constructor(
    private readonly view: ViewPayoutAccount,
    private readonly connect: ConnectPayoutAccount,
    private readonly open: OpenPayoutAccountLink,
  ) {}

  @Get()
  @ReadsSession()
  @ApiOperation({
    summary: "The state of the seller's own payout account",
    description: 'Needs payments.payout-account.view. status is not-connected before the start.',
  })
  @ApiOkResponse({ type: PayoutAccountBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'access.unavailable' })
  async state(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayoutAccountBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    return payoutAccountBody(
      this.answer('payments.view-payout-account-route', context, response, result),
    );
  }

  @Post()
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create the payout account (once) and open the hosted onboarding page',
    description:
      'Needs payments.payout-account.manage (the Seller Owner) and a seller who may sell. ' +
      'Repeating it returns the same account and a new page.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PayoutAccountCodeRequest })
  @ApiOkResponse({ type: PayoutAccountLinkBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed or second-factor.invalid' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, access.seller-not-approved, request.csrf or ' +
      'payments.payout-account.second-factor-required',
  })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'second-factor.locked (retryAfterSeconds)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'payments.unavailable' })
  async connectAccount(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PayoutAccountLinkBody> {
    response.setHeader('Cache-Control', 'no-store');
    const input = codeOf(request, body);
    if (input instanceof HttpException) throw input;
    const result = await this.connect.execute(context, input);
    return payoutAccountLinkBody(
      this.answer('payments.connect-payout-account-route', context, response, result),
    );
  }

  @Post('link')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'A fresh hosted page for the existing payout account',
    description:
      'Needs payments.payout-account.manage. Onboarding until the account is enabled, update ' +
      'afterwards. Answers 404 payments.payout-account.not-found before the account exists.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: PayoutAccountCodeRequest })
  @ApiOkResponse({ type: PayoutAccountLinkBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed or second-factor.invalid' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description:
      'access.denied, access.seller-not-approved, request.csrf or ' +
      'payments.payout-account.second-factor-required',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'payments.payout-account.not-found' })
  @ApiTooManyRequestsResponse({ ...ERROR, description: 'second-factor.locked (retryAfterSeconds)' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'payments.unavailable' })
  async link(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PayoutAccountLinkBody> {
    response.setHeader('Cache-Control', 'no-store');
    const input = codeOf(request, body);
    if (input instanceof HttpException) throw input;
    const result = await this.open.execute(context, input);
    return payoutAccountLinkBody(
      this.answer('payments.open-payout-account-link-route', context, response, result),
    );
  }

  /** The value, or the refusal as an HTTP error; the log line names the outcome only. */
  private answer<T>(
    msg: string,
    context: CallContext,
    response: Response,
    result:
      { ok: true; value: T } | { ok: false; error: { code: string; retryAfterSeconds?: number } },
  ): T {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (result.ok) return result.value;
    const status = PAYOUT_ACCOUNT_STATUS[result.error.code];
    if (status === undefined) throw fail(500, 'internal');
    const wait = result.error.retryAfterSeconds;
    if (wait !== undefined) {
      response.setHeader('Retry-After', String(wait));
      throw fail(status, result.error.code, { retryAfterSeconds: wait });
    }
    throw fail(status, result.error.code);
  }
}
