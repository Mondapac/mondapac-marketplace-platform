import { Controller, Get, HttpCode, HttpException, Logger, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { MarketFromPath } from '../../../platform/http/market-from-path.decorator';
import { UnsubscribeMarketingEmail } from '../application/use-cases/unsubscribe-marketing-email.use-case';
import { ViewUnsubscribeLink } from '../application/use-cases/view-unsubscribe-link.use-case';

const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'notifications.unsubscribe-link-invalid': 400,
  ...ACCESS_DENIED_STATUS,
});

const ERROR = { type: Object };
const TOKEN = { name: 'token', required: true, description: 'The signed token of the mail link' };

const fail = (status: number, code: string): HttpException =>
  new HttpException({ statusCode: status, code }, status);

/**
 * The unsubscribe link of a marketing mail: `/notifications/unsubscribe/<MARKET>?token=<token>`
 * (personalization package 1b). The Market comes from the path because a mail client's one-click
 * POST (RFC 8058) cannot send `x-market-id`. No session is read: the signed token names the
 * account. GET only checks the link (a link scanner changes nothing); POST unsubscribes, with any
 * body (`List-Unsubscribe=One-Click` from a mail client, or none from the storefront page). The
 * token is in the query string, which the request log never records.
 */
@ApiTags('notifications')
@RoutePopulation('customer')
@MarketFromPath()
@Controller('notifications/unsubscribe')
export class UnsubscribeController {
  readonly #logger = new Logger('UnsubscribeController');

  constructor(
    private readonly view: ViewUnsubscribeLink,
    private readonly unsubscribe: UnsubscribeMarketingEmail,
  ) {}

  @Get(':market')
  @ApiOperation({
    summary: 'Check a marketing mail unsubscribe link (public)',
    description: 'Changes nothing. For the storefront page before the reader confirms.',
  })
  @ApiParam({ name: 'market', description: 'The Market id of the mail' })
  @ApiQuery(TOKEN)
  @ApiOkResponse({ schema: { type: 'object', properties: { valid: { type: 'boolean' } } } })
  @ApiBadRequestResponse({ ...ERROR, description: 'notifications.unsubscribe-link-invalid' })
  async check(
    @Call() context: CallContext,
    @Query('token') token: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, { token });
    this.log(context, 'notifications.view-unsubscribe-link-route', result);
    if (!result.ok) throw this.refusal(result.error.code);
    return result.value;
  }

  @Post(':market')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Unsubscribe from marketing email with one click (public)',
    description:
      'RFC 8058 one-click: a mail client posts List-Unsubscribe=One-Click; the storefront page ' +
      'posts with no body. Withdraws the marketing email consent; a second click answers the same.',
  })
  @ApiParam({ name: 'market', description: 'The Market id of the mail' })
  @ApiQuery(TOKEN)
  @ApiOkResponse({ schema: { type: 'object', properties: { unsubscribed: { type: 'boolean' } } } })
  @ApiBadRequestResponse({ ...ERROR, description: 'notifications.unsubscribe-link-invalid' })
  async post(
    @Call() context: CallContext,
    @Query('token') token: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.unsubscribe.execute(context, { token });
    this.log(context, 'notifications.unsubscribe-marketing-email-route', result);
    if (!result.ok) throw this.refusal(result.error.code);
    return result.value;
  }

  private refusal(code: string): HttpException {
    const status = STATUS[code];
    return status === undefined ? fail(500, 'internal') : fail(status, code);
  }

  /** The outcome and the correlation id only: never the token or the account. */
  private log(
    context: CallContext,
    msg: string,
    result: { readonly ok: boolean; readonly error?: { readonly code: string } },
  ): void {
    this.#logger.log({
      msg,
      outcome: result.ok ? 'ok' : result.error?.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
