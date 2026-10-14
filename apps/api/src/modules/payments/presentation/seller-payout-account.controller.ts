import { Controller, Get, HttpCode, HttpException, Logger, Post, Res } from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
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
import { PayoutAccountBody, PayoutAccountLinkBody } from './payout-account.dto';

/** The HTTP status of each refusal of the payout-account routes. */
export const PAYOUT_ACCOUNT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'payments.payout-account.not-found': 404,
  'payments.payout-account.rejected': 409,
  'payments.unavailable': 503,
  ...ACCESS_DENIED_STATUS,
});

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };

const fail = (status: number, code: string): HttpException =>
  new HttpException({ statusCode: status, code }, status);

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
    return this.answer('payments.view-payout-account-route', context, result);
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
  @ApiOkResponse({ type: PayoutAccountLinkBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or request.csrf',
  })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'payments.unavailable' })
  async connectAccount(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayoutAccountLinkBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.connect.execute(context, {});
    return this.answer('payments.connect-payout-account-route', context, result);
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
  @ApiOkResponse({ type: PayoutAccountLinkBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({
    ...ERROR,
    description: 'access.denied, access.seller-not-approved or request.csrf',
  })
  @ApiNotFoundResponse({ ...ERROR, description: 'payments.payout-account.not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'payments.unavailable' })
  async link(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayoutAccountLinkBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.open.execute(context, {});
    return this.answer('payments.open-payout-account-link-route', context, result);
  }

  /** The value, or the refusal as an HTTP error; the log line names the outcome only. */
  private answer<T>(
    msg: string,
    context: CallContext,
    result: { ok: true; value: T } | { ok: false; error: { code: string } },
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
    throw fail(status, result.error.code);
  }
}
